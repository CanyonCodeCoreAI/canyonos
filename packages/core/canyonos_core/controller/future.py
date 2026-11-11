# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The Future that every agent function call returns in place of its result."""

import ast
import asyncio
import time
import json
import secrets
import sys
import os
import logging
import threading
import weakref

import grpc

try:
    import canyonos_core.controller.canyonos_context as canyonos_context
except ImportError:
    import canyonos_context

try:
    from canyonos_core.controller.utils.grpc_options import (
        GRPC_CHANNEL_OPTIONS,
        call_with_retry,
    )
except ImportError:
    from grpc_options import GRPC_CHANNEL_OPTIONS, call_with_retry

try:
    from canyonos_core.controller.utils.log_entry import (
        build_failure_entry,
        append_log_entry,
    )
except ImportError:
    from log_entry import build_failure_entry, append_log_entry

# How often a wait reads Redis anyway, for a value written by another process. A value
# this process's local controller writes wakes it at once (notify_result).
RESULT_RECHECK_SECONDS = 1.0

# future_id -> one Event per call in this process waiting on it.
_result_waiters = {}
_result_waiters_lock = threading.Lock()


def notify_result(future_id):
    """Wake every wait in this process on `future_id`. The local controller calls it
    wherever it writes a future's result or failure."""
    with _result_waiters_lock:
        waiters = list(_result_waiters.get(future_id, ()))
    for arrived in waiters:
        arrived.set()


class AgentCallError(RuntimeError):
    """Raised when a called agent failed; the text is that agent's own error."""


# Declared types whose stored text is JSON (the executor JSON-encodes a dict or list).
_JSON_TYPES = frozenset({"dict", "list"})
# Declared types whose stored text is `str(value)`, which a Python literal reads back.
_LITERAL_TYPES = frozenset({"tuple", "set", "frozenset", "bytes", "complex"})


def _type_names(declared):
    """The builtin names a declared return type allows, outermost first: `dict` for
    `dict[str, int]`, `int` and `None` for `int | None`. Empty when it can't be read."""
    try:
        node = ast.parse(declared, mode="eval").body
    except (SyntaxError, ValueError, RecursionError):
        return []
    names, pending = [], [node]
    while pending:
        node = pending.pop(0)
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
            pending[:0] = [node.left, node.right]
        elif isinstance(node, ast.Subscript):
            pending.insert(0, node.value)
        elif isinstance(node, ast.Name):
            names.append(node.id)
        elif isinstance(node, ast.Constant) and node.value is None:
            names.append("None")
    return names


def _as_type(text, name):
    """`text` read back as the builtin type `name`; raises ValueError when it isn't."""
    if name == "None":
        if text == "None":
            return None
        raise ValueError(text)
    if name == "str":
        return text
    if name == "bool":
        if text in ("True", "False"):
            return text == "True"
        raise ValueError(text)
    if name == "int":
        return int(text)
    if name == "float":
        return float(text)
    if name in _JSON_TYPES:
        value = json.loads(text)
        if isinstance(value, dict if name == "dict" else list):
            return value
        raise ValueError(text)
    if name in _LITERAL_TYPES:
        value = ast.literal_eval(text)
        if type(value).__name__ == name:
            return value
        raise ValueError(text)
    raise ValueError(text)


def convert_result(text, declared):
    """Turn a stored result back into the value its function returned, going by the
    `returns` type declared in `workflow_config.yaml`: `dict` and `list` from JSON,
    numbers and `bool` from their text. The text itself when no type is declared, the
    type is `str` or `object`, or the text doesn't read as that type."""
    if text is None or not declared:
        return text
    for name in _type_names(declared):
        if name == "object":
            return text
        try:
            return _as_type(text, name)
        except (ValueError, SyntaxError, TypeError, MemoryError, RecursionError):
            continue
    return text


def wait_for_result(redis_client, future_id, timeout=None):
    """Wait for a future's result in Redis and return it. Raises AgentCallError with the
    future's error once it failed, and TimeoutError after `timeout` seconds (None: no
    limit). Reads Redis when woken and once every RESULT_RECHECK_SECONDS otherwise."""
    key = f"future:{future_id}"
    # Registered before the first read, so a value written in between still wakes it.
    arrived = threading.Event()
    with _result_waiters_lock:
        _result_waiters.setdefault(future_id, set()).add(arrived)
    try:
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            error = redis_client.hget(key, "error")
            if error or str(redis_client.hget(key, "failed")) == "1":
                raise AgentCallError(
                    error or redis_client.hget(key, "error") or "Unknown error"
                )
            result = redis_client.hget(key, "result")
            if result is not None:
                return result
            wait = RESULT_RECHECK_SECONDS
            if deadline is not None:
                wait = min(wait, deadline - time.monotonic())
                if wait <= 0:
                    raise TimeoutError(
                        f"Future {future_id} not available within {timeout} seconds"
                    )
            if arrived.wait(wait):
                arrived.clear()
    finally:
        with _result_waiters_lock:
            waiters = _result_waiters[future_id]
            waiters.discard(arrived)
            if not waiters:
                del _result_waiters[future_id]


# Add generated grpc_stubs to path (Docker context copies them directly to /app, and local relies on project dir)
sys.path.insert(0, ".")
sys.path.insert(0, "/app")
sys.path.insert(0, os.path.abspath("grpc_stubs"))

try:
    from canyonos_core.controller.utils.redis_client import RedisClient
except ImportError:
    from redis_client import RedisClient
import local_controller_pb2
import local_controller_pb2_grpc

logger = logging.getLogger(__name__)

# Agent images don't ship canyonos_core.endpoint, whose ENDPOINT_AGENT_NAME this matches.
ENDPOINT_AGENT_NAME = "endpoint"

# Every Future this process holds. While it is empty, rewritten agent code skips
# looking through call arguments for Futures (see lazy_values).
LIVE_FUTURES = weakref.WeakSet()

_NOT_RESOLVED = object()


def future_refs(args, is_future):
    """Find every Future in a call's arguments, at any depth of dicts, lists and
    tuples. Return the arguments as JSON can carry them, with each Future replaced by
    its id, and one entry per Future: its path from the argument name down and its
    declared return type."""
    refs = []

    def encode(value, path):
        if is_future(value):
            refs.append({"path": path, "returns": value.returns})
            return value.id
        if isinstance(value, dict):
            # JSON turns every key into a string, so the path names it the same way.
            return {
                k: encode(v, path + [k if isinstance(k, str) else _json_key(k)])
                for k, v in value.items()
            }
        if isinstance(value, (list, tuple)):
            return [encode(v, path + [i]) for i, v in enumerate(value)]
        return value

    encoded = {key: encode(value, [key]) for key, value in args.items()}
    return encoded, refs


def _json_key(key):
    """The string JSON writes for a dict key that isn't one: `1` -> "1", `True` ->
    "true". The key itself when JSON can't write it, which then fails the call."""
    try:
        return next(iter(json.loads(json.dumps({key: 0}))))
    except (TypeError, ValueError):
        return key


# defines the future object which will be returned by each function call
class Future(object):
    """Handle to an agent call running in the background; `value()` blocks until its
    result is in Redis. Pass it to another agent call and that call waits for it."""

    redis = RedisClient(
        host=os.environ.get("CANYONOS_REDIS_HOST", "localhost"),
        port=int(os.environ.get("CANYONOS_REDIS_PORT", 6379)),
    )

    # Defaults for a Future rebuilt without __init__, such as by a test.
    returns = None
    _typed = _NOT_RESOLVED

    # Single local controller connection, shared across all futures
    _lc_host = os.environ.get("CANYONOS_LC_HOST", "localhost")
    _lc_port = os.environ.get("CANYONOS_LC_PORT", "50051")
    _channel = None
    _stub = None

    @classmethod
    def _get_stub(cls):
        """Get or create the cached gRPC stub for the local controller."""
        if cls._stub is None:
            address = f"{cls._lc_host}:{cls._lc_port}"
            cls._channel = grpc.insecure_channel(address, options=GRPC_CHANNEL_OPTIONS)
            cls._stub = local_controller_pb2_grpc.LocalControllerStub(cls._channel)
            logger.info("Connected to local controller at %s", address)
        return cls._stub

    def __init__(self, parent, agent_name, method, args=None, returns=None):
        """
        parent: parent future
        agent_name: agent to be called
        method: method to be called on that agent
        args: arguments to be passed to the method
        returns: the method's declared return type, such as "dict", which the
            result is turned back into when it's used (see `resolved`)
        """

        # 64-bit because this id doubles as the OTel span_id, which is defined as
        # 64-bit, so there's no 128-bit uuid4 to truncate later.
        self.id = secrets.token_hex(8)
        LIVE_FUTURES.add(self)

        # Grab the request_id from the thread-local context (set by the endpoint)
        self.request_id = canyonos_context.get_request_id()

        # this provides the funtionality we need to execute
        self.funtionality = None
        self.executor = None
        self.result = None
        self.parent = canyonos_context.get_current_future_id()
        self.agent_name = agent_name
        self.method = method
        self.returns = returns
        self._typed = _NOT_RESOLVED
        args = args or {}
        # Send each Future arg, at any depth, as its id, with where it sits for the
        # controller to put its result back. future_args keeps the top-level names.
        self.args, self.future_refs = future_refs(args, lambda v: isinstance(v, Future))
        self.future_args = [
            ref["path"][0] for ref in self.future_refs if len(ref["path"]) == 1
        ]
        try:
            args_json = json.dumps(self.args)
        except (TypeError, ValueError):
            # Only on failure: find the argument that can't be sent, to name it.
            for key, value in self.args.items():
                try:
                    json.dumps(value)
                except (TypeError, ValueError) as error:
                    raise TypeError(
                        f"Argument '{key}' of {agent_name}.{method} can't be sent: {error}."
                    ) from None
            raise
        self.children = []
        self.consumers = []
        # For simplicity I am making a decision here, the future value only be sent back to the parent
        # Store scalar fields in a Redis Hash: future:<id>
        self.redis.hset_multiple(
            self._key(),
            {
                "id": self.id,
                "request_id": self.request_id or "",
                "parent": self.parent,
                "service": self.agent_name,
                "method": self.method,
                "args": args_json,
            },
        )
        # Register this future under its request so local controllers can clean it up
        if self.request_id:
            self.redis.sadd(f"request:{self.request_id}:futures", self.id)
        # If a future is calculated, this flag will be true
        self.calculated = False
        # Why the local controller refused the call instead of queueing it, if it did.
        self.refusal = None
        # Submit the request to the local controller
        self._submit_request()

    def _submit_request(self):
        """Send the gRPC request to the local controller."""
        stub = self._get_stub()
        self.redis.hset(self._key(), "created_at", time.time())

        # Send the whole future hash as the request payload -- args and the id/method fields
        # are overridden below since the hash stores args are JSON-encoded (the executor needs the real dict)
        request_data = dict(self.redis.hgetall(self._key()))
        request_data["future_id"] = request_data.pop("id")
        request_data["function"] = request_data.pop("method")
        request_data["args"] = self.args
        request_data["future_args"] = self.future_args
        request_data["future_refs"] = self.future_refs

        request = local_controller_pb2.JsonResponse(response=json.dumps(request_data))
        try:
            self.response = call_with_retry(
                lambda: stub.Execute(request), f"{self._lc_host}:{self._lc_port}"
            )
            logger.debug(
                "Submitted %s.%s (future=%s)", self.agent_name, self.method, self.id
            )
        except Exception as e:
            logger.error(
                "gRPC call failed for %s.%s: %s", self.agent_name, self.method, e
            )
            # A failed RPC's own text is a multi-line dump; its details are the reason.
            reason = e.details() if isinstance(e, grpc.Call) else e
            if isinstance(e, grpc.Call) and e.code() in (
                grpc.StatusCode.UNAVAILABLE,
                grpc.StatusCode.DEADLINE_EXCEEDED,
            ):
                reason = "CanyonOS in the calling container didn't answer in time"
            message = (
                f"Could not send the call to {self.agent_name}.{self.method}: {reason}"
            )
            try:
                self.redis.hset_multiple(
                    f"future:{self.id}",
                    {
                        "error": message,
                        "failed": 1,
                    },
                )
                append_log_entry(
                    self.redis,
                    f"future:{self.id}",
                    build_failure_entry(message, error_name="SendFailed"),
                )
            except Exception as record_error:
                # Never let the failure-recording path itself raise out of the constructor.
                logger.error(
                    "Failed to record submission failure for future %s: %s",
                    self.id,
                    record_error,
                )
            return
        try:
            reply = json.loads(self.response.response)
        except ValueError:
            return
        if isinstance(reply, dict):
            self.refusal = reply.get("refused")

    def _key(self):
        """Redis key for this future's hash."""
        return f"future:{self.id}"

    def _children_key(self):
        """Redis key for this future's children set."""
        return f"future:{self.id}:children"

    def _consumers_key(self):
        """Redis key for this future's consumers set."""
        return f"future:{self.id}:consumers"

    def _poll_redis(self):
        """Check Redis for a computed result and cache it locally."""
        error = self.redis.hget(self._key(), "error")
        if error:
            raise AgentCallError(error)
        result = self.redis.hget(self._key(), "result")
        if result is not None:
            self.result = result

        return self.result

    def value(self, timeout=None):
        """
        This method will block until the value is computed or the timeout is reached.
        Returns immediately if the result is already available locally.
        Waits for the result in Redis (see wait_for_result).
        """
        failed = self.redis.hget(self._key(), "failed")
        if str(failed) == "1":
            raise AgentCallError(
                self.redis.hget(self._key(), "error") or "Unknown error"
            )

        if self.result is not None:
            return self.result

        try:
            self.result = wait_for_result(self.redis, self.id, timeout)
        except TimeoutError:
            raise TimeoutError(
                f"{self.agent_name}.{self.method} did not finish within {timeout} seconds"
            ) from None
        self.calculated = True

        # Note: consumer fan-out is handled entirely by the local controllers at
        # result-write time (see LocalController._fan_out_to_consumers). value()
        # is now purely a top-level pull for whoever holds the root future.
        return self.result

    def resolved(self, timeout=None):
        """Wait like `value()`, but return the result as its declared type: a `dict`
        for a function declared to return `dict`, not its JSON text. Agent code reaches
        this without calling it: CanyonOS rewrites agent modules so any line that uses
        a Future uses this instead (see lazy_values)."""
        if self._typed is _NOT_RESOLVED:
            self._typed = convert_result(self.value(timeout=timeout), self.returns)
        return self._typed

    def __await__(self):
        """`await future`: wait like `resolved()` on a worker thread, so the event loop
        goes on running other tasks, and give the result as its declared type."""
        loop = asyncio.get_running_loop()
        return loop.run_in_executor(None, self.resolved).__await__()

    def __repr__(self):
        call = f"{getattr(self, 'agent_name', '?')}.{getattr(self, 'method', '?')}"
        return f"<Future {call} {getattr(self, 'id', '?')}>"

    # def __call__(self, timeout=None):
    #     """Allow calling the future directly to get the value, e.g. future()."""
    #     return self.value(timeout)

    def is_available(self):
        """
        This method will return True if the value is computed, False otherwise.
        """
        return self.result is not None

    def _get_consumers(self):
        """Return the list of consumers from Redis."""
        return self.redis.smembers(self._consumers_key())

    def _notify_consumers(self):
        """Push this future's result to all registered consumer addresses via gRPC WriteResult."""
        consumers = self._get_consumers()
        if not consumers:
            return
        for address in consumers:
            try:
                if not self.result:
                    logger.warning(
                        "Future %s is notifying consumer %s with an empty/None result",
                        self.id,
                        address,
                    )
                channel = grpc.insecure_channel(address, options=GRPC_CHANNEL_OPTIONS)
                stub = local_controller_pb2_grpc.LocalControllerStub(channel)
                payload = json.dumps({"future_id": self.id, "result": self.result})
                request = local_controller_pb2.JsonResponse(response=payload)
                stub.WriteResult(request)
                logger.info(
                    "Notified consumer %s with result for future %s", address, self.id
                )
            except Exception as e:
                logger.error(
                    "Failed to notify consumer %s for future %s: %s",
                    address,
                    self.id,
                    e,
                )

    def _add_consumer(self, consumer):
        """Add a consumer."""
        self.consumers.append(consumer)
        self.redis.sadd(self._consumers_key(), consumer)

    def _remove_consumer(self, consumer):
        """Remove a consumer."""
        self.consumers.remove(consumer)
        self.redis.srem(self._consumers_key(), consumer)


def _reset_after_fork():
    # The parent's channel may be mid-call on another thread, and its Redis pool lock may
    # have been copied while held, which deadlocks the child's first write.
    Future._stub = None
    Future.redis = RedisClient(
        host=os.environ.get("CANYONOS_REDIS_HOST", "localhost"),
        port=int(os.environ.get("CANYONOS_REDIS_PORT", 6379)),
    )


os.register_at_fork(after_in_child=_reset_after_fork)
