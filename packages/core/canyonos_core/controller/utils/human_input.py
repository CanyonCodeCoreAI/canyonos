# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Lets agent code ask the person who sent the request for input, without changing
the code. During a request, plain `input()`, LangGraph's `interrupt()`, and OpenAI
Agents SDK tool approvals each wait for the reply the person sends to the endpoint's
`POST /answer/<request_id>`. Outside a request they behave as before."""

import asyncio
import builtins
import functools
import importlib
import inspect
import json
import logging
import math
import sys
import time

try:
    import canyonos_core.controller.canyonos_context as canyonos_context
    from canyonos_core.controller.future import (
        ENDPOINT_AGENT_NAME,
        AgentCallError,
        Future,
    )
except ImportError:
    import canyonos_context
    from future import ENDPOINT_AGENT_NAME, AgentCallError, Future

logger = logging.getLogger(__name__)

QUESTION_TIMEOUT_SECONDS = 3600
# The answer a review question takes, as `_approval` reads it.
APPROVAL_SCHEMA = {"approve": "bool", "message": "str | None"}
# How much of one argument's JSON text a review question shows; the rest is cut.
REVIEW_ARGUMENT_MAX_CHARACTERS = 10_000
# The codes a gated call fails with. The dashboard API's FAILURE_CODES lists them too.
REVIEW_REJECTED = "review.rejected"
REVIEW_TIMED_OUT = "review.timed_out"


def _question(question, input_schema, timeout):
    """Put `question` to the person who made this request, who has `timeout` seconds
    to answer, and return the call that waits for their reply."""
    return Future(
        None,
        ENDPOINT_AGENT_NAME,
        "ask_human",
        {
            "question": {"question": question, "input_schema": input_schema},
            # The endpoint stops listing the question once nobody waits for it.
            "timeout_seconds": math.ceil(timeout),
        },
    )


def _ask(question, input_schema, timeout):
    """Put `question` to the person who made this request and return their JSON reply,
    unchecked; raises TimeoutError when none comes within `timeout` seconds."""
    return json.loads(_question(question, input_schema, timeout).value(timeout=timeout))


def ask_human(question, input_schema):
    """Send `question`, and `input_schema`, which maps each key the answer takes to its
    Python type name, to the person who made this request and wait for their reply.
    Returns the JSON body they send to `POST /answer/<request_id>`, unchecked; raises
    TimeoutError when none comes within an hour, and RuntimeError outside a request."""
    if not canyonos_context.get_request_id():
        raise RuntimeError(
            "ask_human() needs a request: it asks the person who sent it"
        )
    try:
        return _ask(question, input_schema, QUESTION_TIMEOUT_SECONDS)
    except TimeoutError:
        raise TimeoutError("The person did not answer within an hour") from None


def _answer(question, input_schema, read):
    """Ask `question` until `read` takes the reply, and return what `read` returns; a
    reply it can't take, such as one missing a key or with a wrong type, is asked again."""
    while True:
        reply = ask_human(question, input_schema)
        try:
            return read(reply)
        except (KeyError, ValueError) as e:
            logger.warning(
                "The answer does not fit %s, asking again: %s", input_schema, e
            )


_TYPE_NAMES = {
    "string": "str",
    "integer": "int",
    "number": "float",
    "boolean": "bool",
    "null": "None",
    "array": "list",
    "object": "dict",
}


def _type_name(schema):
    """Name the Python type a JSON Schema describes, such as `str | None`, a nested
    model by its name, or `any` when it names no type."""
    if not isinstance(schema, dict):
        return "any"
    if "$ref" in schema:
        return schema["$ref"].rsplit("/", 1)[-1]
    if "anyOf" in schema:
        return " | ".join(_type_name(option) for option in schema["anyOf"])
    if isinstance(schema.get("type"), list):
        return " | ".join(_TYPE_NAMES.get(name, "any") for name in schema["type"])
    name = _TYPE_NAMES.get(schema.get("type"), "any")
    return f"{name}[{_type_name(schema['items'])}]" if "items" in schema else name


_original_input = builtins.input


def _input(prompt=""):
    if not canyonos_context.get_request_id():
        return _original_input(prompt)
    answer = _answer(str(prompt), {"input": "str"}, lambda reply: reply["input"])
    return answer if isinstance(answer, str) else json.dumps(answer)


def _patch_langgraph(types):
    """Make `interrupt()` wait for the person's reply and return it, instead of
    pausing the graph for a later `Command(resume=...)`."""
    original = types.interrupt

    @functools.wraps(original)
    def interrupt(value, *args, **kwargs):
        if not canyonos_context.get_request_id():
            return original(value, *args, **kwargs)
        schema = kwargs.get("response_schema")
        # LangChain's human-in-the-loop middleware asks with no schema, then reads the reply's decisions.
        if (
            schema is None
            and isinstance(value, dict)
            and value.keys() == {"action_requests", "review_configs"}
        ):
            schema = importlib.import_module(
                "langchain.agents.middleware.human_in_the_loop"
            ).HITLResponse
        if schema is None or isinstance(schema, dict):
            json_schema, validate = schema or {}, lambda answer: answer
        else:
            # Imported here: LangGraph depends on pydantic, other agents may not have it.
            import pydantic

            adapter = pydantic.TypeAdapter(schema)
            json_schema, validate = adapter.json_schema(), adapter.validate_python
        # A model is answered field by field; any other type as the reply's `input`.
        if "properties" in json_schema:
            input_schema = {
                key: _type_name(field)
                for key, field in json_schema["properties"].items()
            }
            return _answer(value, input_schema, validate)
        return _answer(
            value,
            {"input": _type_name(json_schema)},
            lambda reply: validate(reply["input"]),
        )

    types.interrupt = interrupt


def _approval(reply):
    """Return the reply when its `approve` is true or false; raise ValueError otherwise."""
    if not isinstance(reply["approve"], bool):
        raise ValueError("approve must be true or false")
    return reply


class ReviewRefused(Exception):
    """A reviewer rejected a gated call, none answered in time, or the question failed
    first, such as when its request finished; the call fails with `error_name` and this
    text, without running."""

    def __init__(self, error_name, message):
        super().__init__(message)
        self.error_name = error_name
        self.message = message


def _shown(value):
    """`value` as a review question shows it: as JSON, with what JSON can't hold as its
    `repr`, and cut to REVIEW_ARGUMENT_MAX_CHARACTERS of text."""
    try:
        text = json.dumps(value, default=repr)
    except Exception:
        # A key JSON can't hold, or a value that contains itself.
        text = json.dumps(repr(value))
    if len(text) <= REVIEW_ARGUMENT_MAX_CHARACTERS:
        return json.loads(text)
    return (
        f"{text[:REVIEW_ARGUMENT_MAX_CHARACTERS]}... "
        f"({len(text) - REVIEW_ARGUMENT_MAX_CHARACTERS} more characters)"
    )


def review(agent, method, arguments, reviewers, timeout_seconds):
    """Ask the person who made this request to approve the call to `agent.method` with
    `arguments`, for the reviewer group `reviewers`, before it runs; the Local
    Controller calls it for an agent whose governance rules have a `review`. Returns
    once they approve; raises ReviewRefused when they reject it, no valid answer comes
    within `timeout_seconds`, or the question fails first, with the question's own
    `error_name`. An answer without a true or false `approve` is asked again while
    time is left."""
    question = {
        "kind": "review",
        "agent": agent,
        "method": method,
        "arguments": {name: _shown(value) for name, value in arguments.items()},
        "reviewers": reviewers,
    }
    deadline = time.monotonic() + timeout_seconds
    while (remaining := deadline - time.monotonic()) > 0:
        asked = _question(question, APPROVAL_SCHEMA, remaining)
        try:
            reply = json.loads(asked.value(timeout=remaining))
            _approval(reply)
        except TimeoutError:
            break
        except AgentCallError as e:
            raise ReviewRefused(
                asked.redis.hget(f"future:{asked.id}", "error_name"), str(e)
            ) from None
        except (KeyError, TypeError, ValueError) as e:
            logger.warning(
                "The review answer does not fit %s, asking again: %s",
                APPROVAL_SCHEMA,
                e,
            )
            continue
        if reply["approve"]:
            return
        raise ReviewRefused(
            REVIEW_REJECTED,
            f"Rejected by a reviewer: {reply.get('message') or 'no reason given'}",
        )
    raise ReviewRefused(
        REVIEW_TIMED_OUT,
        f"No reviewer in {reviewers} answered within {timeout_seconds} seconds",
    )


def _decide(result):
    """Ask the person about each tool call waiting for approval, and return the run's
    state with their decisions."""
    state = result.to_state()
    for item in result.interruptions:
        reply = _answer(
            {
                "agent": item.agent.name,
                "tool": item.tool_name,
                "arguments": item.arguments,
            },
            {"approve": "bool", "message": "str | None"},
            _approval,
        )
        if reply["approve"]:
            state.approve(item)
        else:
            state.reject(item, rejection_message=reply.get("message") or None)
    return state


def _patch_openai_agents(run_module):
    """Make `Runner.run` and `Runner.run_sync` settle tool approvals with the person
    and resume, so they return a finished run."""
    runner = getattr(run_module, "Runner", None)
    # A workflow's own package can also be named `agents`.
    if runner is None or not hasattr(runner, "run_sync"):
        return
    state = getattr(run_module, "RunState", None)
    # SDKs before 0.12.1 can't reject with the person's message; before 0.8 have no approvals.
    if (
        state is None
        or "rejection_message" not in inspect.signature(state.reject).parameters
    ):
        return
    run, run_sync = runner.run, runner.run_sync

    async def run_with_approvals(starting_agent, input, **kwargs):
        result = await run(starting_agent, input, **kwargs)
        # The resumed state already carries the run's context.
        resume_kwargs = {k: v for k, v in kwargs.items() if k != "context"}
        while canyonos_context.get_request_id() and result.interruptions:
            state = await asyncio.to_thread(_decide, result)
            result = await run(starting_agent, state, **resume_kwargs)
        return result

    def run_sync_with_approvals(starting_agent, input, **kwargs):
        result = run_sync(starting_agent, input, **kwargs)
        resume_kwargs = {k: v for k, v in kwargs.items() if k != "context"}
        while canyonos_context.get_request_id() and result.interruptions:
            result = run_sync(starting_agent, _decide(result), **resume_kwargs)
        return result

    runner.run = staticmethod(run_with_approvals)
    runner.run_sync = staticmethod(run_sync_with_approvals)


_PATCHES = {
    "langgraph.types": _patch_langgraph,
    "agents.run": _patch_openai_agents,
}


class _PatchOnImport:
    """Import finder that patches a module named in `_PATCHES` as soon as it loads,
    before any code can import names from it."""

    def find_spec(self, name, path, target=None):
        patch = _PATCHES.get(name)
        if patch is None:
            return None
        for finder in sys.meta_path:
            if finder is self or not hasattr(finder, "find_spec"):
                continue
            spec = finder.find_spec(name, path, target)
            if spec is not None:
                break
        else:
            return None
        exec_module = getattr(spec.loader, "exec_module")

        def exec_and_patch(module):
            exec_module(module)
            # A version the patch doesn't fit, such as LangGraph before interrupt(), still imports.
            try:
                patch(module)
            except Exception as e:
                logger.warning(
                    "%s is left as is, so its questions won't reach the person: %s",
                    name,
                    e,
                )

        setattr(spec.loader, "exec_module", exec_and_patch)
        return spec


def install():
    """Send agent code's requests for human input to the person who made the request,
    from now on in this process."""
    if builtins.input is _input:
        return
    setattr(builtins, "input", _input)
    sys.meta_path.insert(0, _PatchOnImport())
