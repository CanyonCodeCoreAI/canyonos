import concurrent.futures
import contextlib
import json
import os
import sys
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import canyonos_core.controller.canyonos_context as canyonos_context
import canyonos_core.controller.deploy as deploy_module
from fakes import _FakeRedis


class _SyncExecutor:
    """Runs submitted work synchronously instead of on a real thread. None of
    these tests need real concurrency, and real threads left running past
    their test method's return would otherwise fire against whichever mock
    happens to be active in a later test."""

    def submit(self, fn, *args):
        future = concurrent.futures.Future()
        future.set_result(fn(*args))
        return future


def _noop_workflow(x=1):
    return {"x": x}


def _failing_workflow(x=1):
    raise RuntimeError("workflow blew up")


class _FakeFuture(deploy_module.Future):
    """Stands in for canyonos_core Future: a reference whose value is pulled."""

    def __init__(self, value, raises=None):
        self.id = "f00d"
        self._value = value
        self._raises = raises
        self.timeouts = []

    def value(self, timeout=None):
        self.timeouts.append(timeout)
        if self._raises is not None:
            raise self._raises
        return self._value


class _Unserializable:
    pass


def _in_process_controller(redis, policy_rules=None):
    """A local controller stand-in that runs the real policy/execute/fail path."""
    from types import SimpleNamespace

    from canyonos_core.controller.local_controller import LocalController

    controller = SimpleNamespace(
        redis=redis,
        agent=None,
        agent_name=None,
        agent_id="workflow-replica",
        logs_enabled=True,
        _my_endpoint="localhost:50051",
        _metrics_key="controller:localhost:50051:metrics",
        _resolve_future_args=lambda args: args,
        _resolve_endpoint=lambda service, request_id: "localhost:50051",
        _policy_rules=policy_rules or [],
        _executor=_SyncExecutor(),
        _executor_futures={},
        _executor_futures_lock=threading.Lock(),
    )
    for name in (
        "_process_request",
        "_load_policy_rules",
        "_check_policy",
        "_execute_locally",
        "_mark_future_failed",
        "_fan_out_to_consumers",
        "_forget_executor_future",
    ):
        method = getattr(LocalController, name)
        setattr(controller, name, lambda *a, _m=method, **k: _m(controller, *a, **k))
    return controller


@contextlib.contextmanager
def _deployed_app(workflow_fn=_noop_workflow, policy_rules=None):
    """Run deploy() with Flask's blocking app.run() replaced by a no-op that
    captures the app instance, so the route handlers can be exercised via
    Flask's test client without starting a real server. The controller is
    a synchronous stand-in reached through Future's gRPC stub, and every patch
    must stay active for the whole `with` block, since a request only reaches
    the controller later, inside handle_workflow()."""
    from types import SimpleNamespace

    captured = {}
    fake_redis = _FakeRedis()
    controller = _in_process_controller(fake_redis, policy_rules)
    stub = SimpleNamespace(
        Execute=lambda req: controller._process_request(json.loads(req.resonse))
    )

    def fake_run(self, *args, **kwargs):
        captured["app"] = self

    # The sync executor runs the workflow on this thread, so its future id would leak into the next test
    canyonos_context.set_current_future_id("")
    with contextlib.ExitStack() as stack:
        stack.enter_context(patch.object(deploy_module.Flask, "run", fake_run))
        stack.enter_context(
            patch.object(deploy_module, "RedisClient", return_value=fake_redis)
        )
        stack.enter_context(patch.object(deploy_module, "controller", controller))
        stack.enter_context(patch.object(deploy_module.Future, "redis", fake_redis))
        stack.enter_context(
            patch.object(deploy_module.Future, "_get_stub", return_value=stub)
        )
        deploy_module.deploy(workflow_fn)
        app = captured["app"]
        # deploy() keeps its RedisClient in a closure, so hang the fake off the app
        # to give tests a way to inspect what landed in Redis.
        app.fake_redis = fake_redis
        yield app


def _post_and_status(app, path, body):
    client = app.test_client()
    request_id = client.post(path, json=body).get_json()["request_id"]
    return request_id, client.get(f"/status/{request_id}").get_json()


class DeployHandleWorkflowTests(unittest.TestCase):
    def test_accepts_the_request_and_returns_a_request_id(self):
        with _deployed_app() as app:
            resp = app.test_client().post("/_noop_workflow", json={"x": 2})

            self.assertEqual(resp.status_code, 202)
            self.assertIn("request_id", resp.get_json())

    def test_a_workflow_returning_a_future_stores_the_resolved_value(self):
        # A workflow is meant to call .value() itself, but when it returns the
        # future instead, this module is the root holder that resolves it --
        # json.dumps on the reference used to fail a request whose work had
        # already completed.
        future = _FakeFuture("the real answer")

        def returns_future(x=1):
            return future

        with _deployed_app(workflow_fn=returns_future) as app:
            _, status = _post_and_status(app, "/returns_future", {"x": 2})

            self.assertEqual(status["status"], "done")
            self.assertEqual(status["result"], {"value": "the real answer"})

    def test_a_future_nested_in_the_result_is_resolved_too(self):
        def returns_nested_future(x=1):
            return {"answer": _FakeFuture(42), "plain": "kept"}

        with _deployed_app(workflow_fn=returns_nested_future) as app:
            _, status = _post_and_status(app, "/returns_nested_future", {"x": 2})

            self.assertEqual(status["result"], {"answer": 42, "plain": "kept"})

    def test_future_resolution_is_bounded(self):
        # Unbounded, an agent that never writes a result would hang the request
        # thread instead of failing.
        future = _FakeFuture("v")

        def returns_future(x=1):
            return future

        with _deployed_app(workflow_fn=returns_future) as app:
            app.test_client().post("/returns_future", json={"x": 2})

        self.assertEqual(future.timeouts, [deploy_module.FUTURE_RESULT_TIMEOUT_SECONDS])

    def test_an_unserializable_result_names_the_workflow(self):
        # The bare "Object of type X is not JSON serializable" replaced whatever
        # the request had actually failed on; the message must say where it came
        # from.
        def returns_unserializable(x=1):
            return {"bad": _Unserializable()}

        with _deployed_app(workflow_fn=returns_unserializable) as app:
            _, status = _post_and_status(app, "/returns_unserializable", {"x": 2})

            self.assertEqual(status["status"], "error")
            self.assertIn("returns_unserializable", status["error"])
            self.assertIn("cannot be sent", status["error"])

    def test_does_not_write_dead_workflow_and_created_at_keys(self):
        with _deployed_app() as app:
            client = app.test_client()
            resp = client.post("/_noop_workflow", json={"x": 2})
            request_id = resp.get_json()["request_id"]

            self.assertNotIn(f"request:{request_id}:workflow", app.fake_redis.store)
            self.assertNotIn(f"request:{request_id}:created_at", app.fake_redis.store)


class DeployRequestCleanupTests(unittest.TestCase):
    """A finished request must be queued for cleanup, or its keys live for the
    lifetime of the Redis instance and eventually OOM it."""

    def test_a_successful_request_is_queued_for_cleanup(self):
        with _deployed_app() as app:
            request_id, _ = _post_and_status(app, "/_noop_workflow", {"x": 2})

            self.assertIn(request_id, app.fake_redis.smembers("request:completed"))

    def test_a_failed_request_is_queued_for_cleanup(self):
        with _deployed_app(workflow_fn=_failing_workflow) as app:
            request_id, _ = _post_and_status(app, "/_failing_workflow", {"x": 2})

            self.assertIn(request_id, app.fake_redis.smembers("request:completed"))

    def test_a_rejected_request_is_queued_for_cleanup(self):
        with _deployed_app(policy_rules=[{"match": {}, "access": []}]) as app:
            request_id, _ = _post_and_status(app, "/_noop_workflow", {"x": 2})

            self.assertIn(request_id, app.fake_redis.smembers("request:completed"))


class DeployStatusTests(unittest.TestCase):
    """/status is served entirely from Redis now that the Postgres `session` table is
    gone -- durable post-TTL history lives in the external API, not in core."""

    def test_serves_a_finished_request_from_redis(self):
        with _deployed_app() as app:
            request_id, status = _post_and_status(app, "/_noop_workflow", {"x": 2})

            self.assertEqual(
                status,
                {"request_id": request_id, "status": "done", "result": {"x": 2}},
            )

    def test_serves_the_error_message_of_a_failed_run(self):
        with _deployed_app(workflow_fn=_failing_workflow) as app:
            request_id, status = _post_and_status(app, "/_failing_workflow", {"x": 2})

            self.assertEqual(
                status,
                {
                    "request_id": request_id,
                    "status": "error",
                    "error": "workflow blew up",
                },
            )

    def test_a_rejected_run_is_an_error_not_pending_forever(self):
        with _deployed_app(policy_rules=[{"match": {}, "access": []}]) as app:
            request_id, status = _post_and_status(app, "/_noop_workflow", {"x": 2})

            self.assertEqual(
                status,
                {"request_id": request_id, "status": "error", "error": "PolicyDenied"},
            )

    def test_404s_when_redis_has_nothing(self):
        # Once cleanup expires the request's keys there is no session fallback --
        # /status must 404 rather than error.
        with _deployed_app() as app:
            resp = app.test_client().get("/status/unknown-id")

            self.assertEqual(resp.status_code, 404)
            self.assertEqual(resp.get_json(), {"error": "Request not found"})


class WorkflowFutureTests(unittest.TestCase):
    def _run(self, workflow_fn, policy_rules=None):
        with (
            patch.object(deploy_module, "workflow_name", "Workflow"),
            _deployed_app(workflow_fn, policy_rules) as app,
        ):
            request_id = (
                app.test_client()
                .post(f"/{workflow_fn.__name__}", json={"x": 2})
                .get_json()["request_id"]
            )
            futures = [
                app.fake_redis.hgetall(key)
                for key in app.fake_redis.scan_keys("future:*")
                if key.count(":") == 1
            ]
            return app.fake_redis, request_id, futures

    def test_a_successful_run_is_recorded_as_a_future(self):
        redis, request_id, futures = self._run(_noop_workflow)

        [future] = futures
        self.assertEqual(json.loads(future["result"]), {"x": 2})
        self.assertEqual(future["service"], "Workflow")
        self.assertEqual(future["method"], "_noop_workflow")
        self.assertEqual(future["request_id"], request_id)
        self.assertEqual(str(future["failed"]), "0")
        self.assertIn("finished_at", future)
        self.assertEqual(
            redis.smembers(f"request:{request_id}:futures"), {future["id"]}
        )

    def test_a_failed_run_is_recorded_on_its_future(self):
        _, _, futures = self._run(_failing_workflow)

        [future] = futures
        self.assertEqual(str(future["failed"]), "1")
        self.assertEqual(future["error"], "RuntimeError")
        logs = json.loads(future["logs"])
        self.assertEqual(logs[-1]["Attributes"]["exception.type"], "RuntimeError")

    def test_a_rejected_run_keeps_its_full_record(self):
        redis, request_id, futures = self._run(
            _noop_workflow, policy_rules=[{"match": {}, "access": []}]
        )

        [future] = futures
        self.assertEqual(future["error"], "PolicyDenied")
        self.assertEqual(future["service"], "Workflow")
        self.assertEqual(future["request_id"], request_id)
        self.assertEqual(
            redis.smembers(f"request:{request_id}:futures"), {future["id"]}
        )


if __name__ == "__main__":
    unittest.main()
