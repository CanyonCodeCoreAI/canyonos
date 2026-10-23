# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import builtins
import contextvars
import importlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest.mock import patch

import canyonos_core.controller.canyonos_context as canyonos_context
import canyonos_core.controller.local_controller  # noqa: F401  installs the patches
from canyonos_core.controller.utils import human_input


def _in_request(fn, *args, **kwargs):
    """Run `fn` as agent code does while serving request r1."""

    def run():
        canyonos_context.set_request_id("r1")
        return fn(*args, **kwargs)

    return contextvars.copy_context().run(run)


class _Review:
    """A model as the fake pydantic sees it, with the JSON Schema real pydantic makes."""

    JSON_SCHEMA = {
        "properties": {
            "approved": {"title": "Approved", "type": "boolean"},
            "draft": {
                "anyOf": [{"type": "string"}, {"type": "null"}],
                "default": None,
                "title": "Draft",
            },
        },
        "required": ["approved"],
        "title": "Review",
        "type": "object",
    }

    def __init__(self, approved, draft=None):
        self.approved, self.draft = approved, draft


class _FakePackages(unittest.TestCase):
    """Writes fake third-party packages to a temp dir and imports them fresh."""

    FILES = {}

    def setUp(self):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root)
        for name, source in self.FILES.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(textwrap.dedent(source))
        sys.path.insert(0, str(root))
        self.addCleanup(sys.path.remove, str(root))
        self._forget_fakes()
        self.addCleanup(self._forget_fakes)
        importlib.invalidate_caches()

    def _forget_fakes(self):
        packages = {name.split("/")[0] for name in self.FILES}
        for module in list(sys.modules):
            if module.split(".")[0] in packages:
                del sys.modules[module]


class PlainPythonTests(unittest.TestCase):
    def test_controller_import_installs_the_patches(self):
        self.assertIs(builtins.input, human_input._input)

    def test_input_asks_with_its_prompt_for_a_str_and_returns_it(self):
        with patch.object(
            human_input, "ask_human", return_value={"input": "yes"}
        ) as ask:
            self.assertEqual(_in_request(input, "Approve? "), "yes")
        ask.assert_called_once_with("Approve? ", {"input": "str"})

    def test_input_returns_json_text_for_an_answer_that_is_not_text(self):
        answer = {"approve": True, "note": "ok"}
        with patch.object(human_input, "ask_human", return_value={"input": answer}):
            self.assertEqual(json.loads(_in_request(input, "?")), answer)

    def test_input_asks_again_when_the_reply_has_no_input(self):
        replies = [{"answer": "no"}, {"input": "no"}]
        with (
            patch.object(human_input, "ask_human", side_effect=replies) as ask,
            self.assertLogs(human_input.logger, "WARNING"),
        ):
            self.assertEqual(_in_request(input), "no")
        self.assertEqual(ask.call_count, 2)

    def test_input_outside_a_request_reads_as_before(self):
        with (
            patch.object(human_input, "_original_input", return_value="typed") as read,
            patch.object(human_input, "ask_human") as ask,
        ):
            self.assertEqual(input("> "), "typed")
        read.assert_called_once_with("> ")
        ask.assert_not_called()


class TypeNameTests(unittest.TestCase):
    def test_pydantic_json_schemas_are_named_as_python_types(self):
        # As pydantic describes a nested model, a Literal, int, float, dict and list.
        cases = [
            ({"$ref": "#/$defs/Address"}, "Address"),
            ({"enum": ["a", "b"], "type": "string"}, "str"),
            ({"type": "integer"}, "int"),
            ({"type": "number"}, "float"),
            ({"additionalProperties": {"type": "integer"}, "type": "object"}, "dict"),
            ({"items": {"type": "string"}, "type": "array"}, "list[str]"),
            ({}, "any"),
            # As a hand-written JSON Schema may put them.
            ({"type": ["string", "null"]}, "str | None"),
            (True, "any"),
            ({"items": [{"type": "string"}], "type": "array"}, "list[any]"),
        ]
        for schema, name in cases:
            with self.subTest(name):
                self.assertEqual(human_input._type_name(schema), name)


class InstallOrderTests(unittest.TestCase):
    def test_a_library_the_gateway_hooks_import_keeps_the_patched_input(self):
        # httpx loads click this way, which keeps the input() it was imported with.
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root)
        (root / "httpx.py").write_text(
            textwrap.dedent("""
                BOUND_INPUT = input


                class Client:
                    def send(self, request):
                        pass


                class AsyncClient:
                    async def send(self, request):
                        pass
            """)
        )
        check = (
            "import sys\n"
            "import canyonos_core.controller.local_controller\n"
            "from canyonos_core.controller.utils import human_input\n"
            "print(sys.modules['httpx'].BOUND_INPUT is human_input._input)"
        )
        result = subprocess.run(
            [sys.executable, "-c", check],
            env={**os.environ, "PYTHONPATH": os.pathsep.join([str(root), *sys.path])},
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.stdout.strip(), "True", result.stderr)


class LangGraphTests(_FakePackages):
    FILES = {
        "langgraph/__init__.py": "",
        "langgraph/types.py": """
            def interrupt(value, *, response_schema=None):
                raise RuntimeError("graph paused")
        """,
        "pydantic/__init__.py": """
            class ValidationError(ValueError):
                pass


            class TypeAdapter:
                def __init__(self, schema):
                    self.schema = schema

                def json_schema(self):
                    if self.schema is bool:
                        return {"type": "boolean"}
                    return self.schema.JSON_SCHEMA

                def validate_python(self, value):
                    if self.schema is bool:
                        if not isinstance(value, bool):
                            raise ValidationError(f"{value!r} is not a bool")
                        return value
                    try:
                        return self.schema(**value)
                    except TypeError as e:
                        raise ValidationError(str(e)) from None
        """,
        "langchain/__init__.py": "",
        "langchain/agents/__init__.py": "",
        "langchain/agents/middleware/__init__.py": "",
        "langchain/agents/middleware/human_in_the_loop.py": """
            class HITLResponse:
                # What pydantic makes of LangChain's HITLResponse, without the $defs.
                JSON_SCHEMA = {
                    "properties": {
                        "decisions": {
                            "items": {
                                "anyOf": [
                                    {"$ref": "#/$defs/ApproveDecision"},
                                    {"$ref": "#/$defs/EditDecision"},
                                    {"$ref": "#/$defs/RejectDecision"},
                                    {"$ref": "#/$defs/RespondDecision"},
                                ]
                            },
                            "title": "Decisions",
                            "type": "array",
                        }
                    },
                    "required": ["decisions"],
                    "title": "HITLResponse",
                    "type": "object",
                }

                def __init__(self, decisions):
                    self.decisions = decisions
        """,
    }

    def test_interrupt_asks_for_any_input_and_returns_it(self):
        from langgraph.types import interrupt

        payload = {"action": "send_email", "to": "alice@example.com"}
        answer = {"action": "approve", "subject": "Updated"}
        with patch.object(
            human_input, "ask_human", return_value={"input": answer}
        ) as ask:
            self.assertEqual(_in_request(interrupt, payload), answer)
        ask.assert_called_once_with(payload, {"input": "any"})

    def test_interrupt_with_a_bare_type_asks_for_input_of_that_type(self):
        from langgraph.types import interrupt

        with patch.object(
            human_input, "ask_human", return_value={"input": True}
        ) as ask:
            answer = _in_request(interrupt, "approve?", response_schema=bool)
        self.assertIs(answer, True)
        ask.assert_called_once_with("approve?", {"input": "bool"})

    def test_interrupt_asks_again_when_the_input_has_the_wrong_type(self):
        from langgraph.types import interrupt

        replies = [{"input": "maybe"}, {"input": False}]
        with (
            patch.object(human_input, "ask_human", side_effect=replies) as ask,
            self.assertLogs(human_input.logger, "WARNING"),
        ):
            answer = _in_request(interrupt, "approve?", response_schema=bool)
        self.assertIs(answer, False)
        self.assertEqual(ask.call_count, 2)

    def test_interrupt_asks_for_each_field_of_a_model_and_builds_it(self):
        from langgraph.types import interrupt

        with patch.object(
            human_input, "ask_human", return_value={"approved": True, "draft": "Hi"}
        ) as ask:
            review = _in_request(interrupt, "approve?", response_schema=_Review)
        self.assertIsInstance(review, _Review)
        self.assertEqual((review.approved, review.draft), (True, "Hi"))
        ask.assert_called_once_with(
            "approve?", {"approved": "bool", "draft": "str | None"}
        )

    def test_interrupt_asks_again_when_the_reply_does_not_fit_the_model(self):
        from langgraph.types import interrupt

        replies = [{"approve": True}, {"approved": True}]
        with (
            patch.object(human_input, "ask_human", side_effect=replies) as ask,
            self.assertLogs(human_input.logger, "WARNING"),
        ):
            review = _in_request(interrupt, "approve?", response_schema=_Review)
        self.assertIs(review.approved, True)
        self.assertEqual(ask.call_count, 2)

    def test_interrupt_from_langchains_approval_middleware_asks_for_decisions(self):
        from langgraph.types import interrupt

        request = {"action_requests": [{"name": "delete_file"}], "review_configs": []}
        replies = [{"approve": True}, {"decisions": [{"type": "approve"}]}]
        with (
            patch.object(human_input, "ask_human", side_effect=replies) as ask,
            self.assertLogs(human_input.logger, "WARNING"),
        ):
            response = _in_request(interrupt, request)
        self.assertEqual(response.decisions, [{"type": "approve"}])
        ask.assert_called_with(
            request,
            {
                "decisions": "list[ApproveDecision | EditDecision | RejectDecision"
                " | RespondDecision]"
            },
        )

    def test_interrupt_with_a_json_schema_asks_for_its_properties(self):
        from langgraph.types import interrupt

        schema = {"type": "object", "properties": {"approved": {"type": "boolean"}}}
        with patch.object(
            human_input, "ask_human", return_value={"approved": True}
        ) as ask:
            answer = _in_request(interrupt, "approve?", response_schema=schema)
        self.assertEqual(answer, {"approved": True})
        ask.assert_called_once_with("approve?", {"approved": "bool"})

    def test_interrupt_with_a_json_schema_of_one_value_asks_for_input(self):
        from langgraph.types import interrupt

        with patch.object(
            human_input, "ask_human", return_value={"input": ["a", "b"]}
        ) as ask:
            answer = _in_request(
                interrupt,
                "tags?",
                response_schema={"type": "array", "items": {"type": "string"}},
            )
        self.assertEqual(answer, ["a", "b"])
        ask.assert_called_once_with("tags?", {"input": "list[str]"})

    def test_interrupt_outside_a_request_pauses_the_graph_as_before(self):
        from langgraph.types import interrupt

        with self.assertRaisesRegex(RuntimeError, "graph paused"):
            interrupt("approve?")


class LangGraphBeforeInterruptTests(_FakePackages):
    FILES = {"langgraph/__init__.py": "", "langgraph/types.py": "STREAM_MODES = 3\n"}

    def test_types_still_import_with_a_warning(self):
        with self.assertLogs(human_input.logger, "WARNING") as logs:
            from langgraph import types

        self.assertEqual(types.STREAM_MODES, 3)
        self.assertIn("langgraph.types is left as is", logs.output[0])


class OpenAIAgentsTests(_FakePackages):
    FILES = {
        "agents/__init__.py": "from agents.run import Runner",
        "agents/run.py": """
            from types import SimpleNamespace


            class RunState:
                def __init__(self):
                    self.approved, self.rejected = [], []

                def approve(self, item):
                    self.approved.append(item.tool_name)

                def reject(self, item, rejection_message=None):
                    self.rejected.append((item.tool_name, rejection_message))


            class Result:
                def __init__(self, interruptions):
                    self.interruptions = interruptions
                    self.state = RunState()

                def to_state(self):
                    return self.state


            def _item(tool):
                return SimpleNamespace(
                    agent=SimpleNamespace(name="Ops"), tool_name=tool, arguments="{}"
                )


            class Runner:
                calls = []

                @classmethod
                def _result(cls, input, kwargs):
                    cls.calls.append((input, kwargs))
                    if isinstance(input, RunState):
                        return Result([])
                    return Result([_item("delete_file"), _item("send_email")])

                @classmethod
                async def run(cls, starting_agent, input, **kwargs):
                    return cls._result(input, kwargs)

                @classmethod
                def run_sync(cls, starting_agent, input, **kwargs):
                    return cls._result(input, kwargs)
        """,
    }

    REPLIES = [{"approve": True}, {"approve": False, "message": "Not today"}]

    def _check_resumed(self, result, ask):
        from agents.run import Runner, RunState

        self.assertEqual(result.interruptions, [])
        self.assertEqual(
            [call.args[0] for call in ask.call_args_list],
            [
                {"agent": "Ops", "tool": "delete_file", "arguments": "{}"},
                {"agent": "Ops", "tool": "send_email", "arguments": "{}"},
            ],
        )
        self.assertEqual(
            ask.call_args.args[1], {"approve": "bool", "message": "str | None"}
        )
        state, resume_kwargs = Runner.calls[-1]
        self.assertIsInstance(state, RunState)
        self.assertEqual(state.approved, ["delete_file"])
        self.assertEqual(state.rejected, [("send_email", "Not today")])
        # The state carries the run context; the rest of the run's settings go with it.
        self.assertEqual(resume_kwargs, {"max_turns": 3})

    def test_run_asks_about_each_approval_and_resumes(self):
        from agents import Runner

        with patch.object(human_input, "ask_human", side_effect=self.REPLIES) as ask:
            result = _in_request(
                asyncio.run, Runner.run("agent", "go", context={"k": 1}, max_turns=3)
            )
        self._check_resumed(result, ask)

    def test_run_sync_asks_about_each_approval_and_resumes(self):
        from agents import Runner

        with patch.object(human_input, "ask_human", side_effect=self.REPLIES) as ask:
            result = _in_request(
                Runner.run_sync, "agent", "go", context={"k": 1}, max_turns=3
            )
        self._check_resumed(result, ask)

    def test_a_rejection_with_an_empty_message_uses_the_sdks_own(self):
        from agents import Runner

        replies = [{"approve": False, "message": ""}, {"approve": False}]
        with patch.object(human_input, "ask_human", side_effect=replies):
            _in_request(Runner.run_sync, "agent", "go")

        state, _ = Runner.calls[-1]
        self.assertEqual(state.rejected, [("delete_file", None), ("send_email", None)])

    def test_an_approval_without_a_true_or_false_approve_is_asked_again(self):
        from agents import Runner

        replies = [{"approve": "yes"}, {"message": "ok"}, *self.REPLIES]
        with (
            patch.object(human_input, "ask_human", side_effect=replies) as ask,
            self.assertLogs(human_input.logger, "WARNING") as logs,
        ):
            _in_request(Runner.run_sync, "agent", "go")
        self.assertEqual(ask.call_count, 4)
        self.assertEqual(len(logs.output), 2)

    def test_outside_a_request_approvals_are_left_to_the_caller(self):
        from agents import Runner

        with patch.object(human_input, "ask_human") as ask:
            result = Runner.run_sync("agent", "go")
        self.assertEqual(len(result.interruptions), 2)
        ask.assert_not_called()


class OpenAIAgentsBeforeApprovalsTests(_FakePackages):
    FILES = {
        "agents/__init__.py": "from agents.run import Runner",
        "agents/run.py": """
            from types import SimpleNamespace


            class Runner:
                @classmethod
                async def run(cls, starting_agent, input, **kwargs):
                    return SimpleNamespace(final_output="done")

                @classmethod
                def run_sync(cls, starting_agent, input, **kwargs):
                    return SimpleNamespace(final_output="done")
        """,
    }

    def test_runs_return_as_before_in_a_request(self):
        from agents import Runner

        self.assertEqual(
            _in_request(asyncio.run, Runner.run("agent", "go")).final_output, "done"
        )
        self.assertEqual(
            _in_request(Runner.run_sync, "agent", "go").final_output, "done"
        )


class OpenAIAgentsBeforeRejectionMessageTests(_FakePackages):
    FILES = {
        "agents/__init__.py": "from agents.run import Runner",
        "agents/run.py": """
            from types import SimpleNamespace


            class RunState:
                def reject(self, approval_item, always_reject=False):
                    pass


            class Runner:
                @classmethod
                async def run(cls, starting_agent, input, **kwargs):
                    return cls.run_sync(starting_agent, input)

                @classmethod
                def run_sync(cls, starting_agent, input, **kwargs):
                    return SimpleNamespace(interruptions=["delete_file"])
        """,
    }

    def test_runs_return_their_approvals_unasked_in_a_request(self):
        from agents import Runner

        with patch.object(human_input, "ask_human") as ask:
            result = _in_request(Runner.run_sync, "agent", "go")
        self.assertEqual(result.interruptions, ["delete_file"])
        ask.assert_not_called()


class ProjectAgentsPackageTests(_FakePackages):
    FILES = {"agents/__init__.py": "", "agents/run.py": "STEPS = 3\n"}

    def test_a_project_package_named_agents_imports_untouched(self):
        from agents import run

        self.assertEqual(run.STEPS, 3)


if __name__ == "__main__":
    unittest.main()
