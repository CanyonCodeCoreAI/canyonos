# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos deploy --target kubernetes` and its companions: what they render from the
project's config, and how they drive kubectl. No cluster or Docker is touched."""

import io
import json
import os
import sys
from types import SimpleNamespace
from unittest.mock import patch

import pytest
import yaml

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos import kubernetes_target
from canyonos.project import normalise

DIGEST = "localhost:5001/canyonos-demo-helloagent@sha256:" + "a" * 64
WORKFLOW_DIGEST = "localhost:5001/canyonos-demo-workflow@sha256:" + "b" * 64


def config(**k8s):
    return {
        "agents": [
            {"name": "HelloAgent", "replicas": 2, "redis_port": 6380,
             "functions": [{"name": "hello", "arguments": [{"name": "name"}]}]},
            {"name": "Workflow", "resources": {"cpu": 2, "memory": 1024},
             "functions": [{"name": "main", "arguments": [{"name": "query"}]}]},
        ],
        "endpoint": {"agent": "Workflow", "method": "main"},
        "poll_interval": 5,
        "kubernetes": {"namespace": "acme", "registry": "localhost:5001", **k8s},
    }  # fmt: skip


def test_the_naming_rule_matches_the_operator():
    assert kubernetes_target.resource_name("Portfolio_Agent") == "portfolio-agent"
    assert kubernetes_target.resource_name("HelloAgent") == "helloagent"
    with pytest.raises(RuntimeError):
        kubernetes_target.resource_name("___")


def test_a_missing_kubernetes_block_says_how_to_add_it(tmp_path):
    path = tmp_path / "global_controller.yaml"
    path.write_text("agents: []\n")
    with pytest.raises(RuntimeError, match="needs a `kubernetes:` block"):
        kubernetes_target.load_config(str(path))


class FakeCluster:
    """kubectl answers from canned objects, recording every call."""

    def __init__(self, project, agents):
        self.project, self.agents, self.calls = project, agents, []

    def kubectl_json(self, args):
        self.calls.append(args)
        return self.project if args[1] == "canyonproject" else {"items": self.agents}


def _ready(obj, status="True", reason="Ready", message=""):
    obj.setdefault("status", {})["conditions"] = [
        {"type": "Ready", "status": status, "reason": reason, "message": message}
    ]
    return obj


def test_deploy_waits_until_the_project_and_every_agent_are_ready():
    project = _ready({}, "False", "Starting")
    agent = _ready(
        {
            "spec": {"agentName": "HelloAgent", "replicas": 1},
            "status": {"readyReplicas": 0},
        },
        "False",
        "Starting",
    )
    cluster = FakeCluster(project, [agent])
    sleeps = []

    def sleep(_):
        sleeps.append(1)
        _ready(project)
        _ready(agent)

    with patch("canyonos.kubernetes_target.kubectl_json", cluster.kubectl_json):
        kubernetes_target.wait_until_ready("acme", "demo", sleep=sleep, clock=lambda: 0)

    assert len(sleeps) == 1


def test_deploy_fails_at_once_on_an_agent_that_will_never_start():
    agent = _ready(
        {"spec": {"agentName": "Hello"}},
        "False",
        "NameMismatch",
        'must be named "hello"',
    )
    cluster = FakeCluster(_ready({}), [agent])
    with patch("canyonos.kubernetes_target.kubectl_json", cluster.kubectl_json):
        with pytest.raises(RuntimeError, match='Hello: must be named "hello"'):
            kubernetes_target.wait_until_ready(
                "acme", "demo", sleep=lambda _: None, clock=lambda: 0
            )


def test_an_agent_with_no_node_says_why_and_is_waited_for():
    agent = _ready(
        {
            "spec": {"agentName": "HelloAgent", "replicas": 1},
            "status": {"readyReplicas": 0},
        },
        "False",
        "Unschedulable",
        "helloagent-0 has no node to run on: 0/2 nodes are available",
    )
    cluster = FakeCluster(_ready({}), [agent])
    with patch("canyonos.kubernetes_target.kubectl_json", cluster.kubectl_json):
        with pytest.raises(RuntimeError, match="no node to run on"):
            kubernetes_target.wait_until_ready(
                "acme",
                "demo",
                timeout=0,
                sleep=lambda _: None,
                clock=iter([0, 1]).__next__,
            )


def test_serve_opens_the_clusters_dashboard_through_a_port_forward():
    with (
        patch(
            "canyonos.kubernetes_target.kubectl",
            return_value=SimpleNamespace(returncode=0),
        ),
        patch("canyonos.kubernetes_target.subprocess.call", return_value=0) as call,
        patch("canyonos.kubernetes_target.ui"),
    ):
        kubernetes_target.run_kubernetes_serve(port=8090)

    call.assert_called_once_with(
        [
            "kubectl",
            "port-forward",
            "-n",
            "canyonos-dashboard",
            "svc/canyonos-dashboard-web",
            "8090:8080",
        ]
    )


def test_serve_says_how_to_install_a_missing_dashboard():
    with patch(
        "canyonos.kubernetes_target.kubectl",
        return_value=SimpleNamespace(returncode=1, stderr="forbidden"),
    ):
        with pytest.raises(RuntimeError, match="dashboard.enabled=true"):
            kubernetes_target.run_kubernetes_serve()


def _upload_names(project_dir=None):
    import tarfile

    archive = kubernetes_target.source_tarball(project_dir)
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        return tar.getnames()


def test_the_upload_leaves_secrets_and_history_behind(tmp_path):
    for name in (".env", ".env.local", ".env.production"):
        (tmp_path / name).write_text("OPENAI_API_KEY=sk-secret\n")
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "HEAD").write_text("ref")
    (tmp_path / "config").mkdir()
    (tmp_path / "config" / "global_controller.yaml").write_text("agents: []\n")
    (tmp_path / "__pycache__").mkdir()
    (tmp_path / "__pycache__" / "x.pyc").write_text("x")

    names = _upload_names(str(tmp_path))

    assert "config/global_controller.yaml" in names
    assert not [
        n for n in names if n.startswith((".env", ".git")) or "__pycache__" in n
    ]


def test_a_converted_project_uploads_its_canyon_folder_as_the_root(
    tmp_path, monkeypatch
):
    """The build runs in the uploaded root, as Docker's sync copies `.canyon`: the
    original source beside it stays here."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "original_agent.py").write_text("print('the source before convert')\n")
    (tmp_path / ".canyon" / "config").mkdir(parents=True)
    (tmp_path / ".canyon" / "config" / "global_controller.yaml").write_text(
        "agents: []\n"
    )
    (tmp_path / ".canyon" / "agent.py").write_text("print('converted')\n")

    names = _upload_names()

    assert sorted(names) == ["agent.py", "config", "config/global_controller.yaml"]


def test_a_dotenv_saved_with_a_byte_order_mark_keeps_its_first_key(tmp_path):
    # Windows Notepad saves one; python-dotenv drops it, so the Secret's first key is
    # valid. Kept so an upgrade that stops doing so is caught.
    path = tmp_path / ".env"
    path.write_bytes("﻿OPENAI_API_KEY=sk-1\nOTHER=2\n".encode("utf-8"))

    assert kubernetes_target.read_dotenv(str(path)) == {
        "OPENAI_API_KEY": "sk-1",
        "OTHER": "2",
    }


def test_a_cluster_on_another_release_stops_the_deploy_before_the_upload(monkeypatch):
    monkeypatch.setattr(kubernetes_target.env, "is_development", False)
    monkeypatch.setattr(kubernetes_target.env, "VERSION", "0.1.740")
    with patch("canyonos.kubernetes_target.kubectl") as kubectl:
        with pytest.raises(RuntimeError) as raised:
            kubernetes_target.check_operator_version(
                "acme", "demo-t1", {"phase": "Receiving", "operatorVersion": "0.1.739"}
            )
    message = str(raised.value)
    assert "CanyonOS 0.1.739" in message and "CLI is 0.1.740" in message
    assert "Upgrading the operator" in message
    # The build waits for an upload that will not come: it goes with the deploy.
    assert kubectl.call_args.args[0][:3] == ["delete", "canyonbuild", "demo-t1"]


@pytest.mark.parametrize(
    ("development", "operator"),
    [
        (False, "0.1.740"),  # the same release
        (False, None),  # an operator that reports no version
        (True, "0.1.739"),  # a CLI from a checkout
    ],
)
def test_the_release_check_lets_these_deploys_through(
    monkeypatch, development, operator
):
    monkeypatch.setattr(kubernetes_target.env, "is_development", development)
    monkeypatch.setattr(kubernetes_target.env, "VERSION", "0.1.740")
    status = {"phase": "Receiving"}
    if operator:
        status["operatorVersion"] = operator
    with patch("canyonos.kubernetes_target.kubectl") as kubectl:
        kubernetes_target.check_operator_version("acme", "demo-t1", status)
    kubectl.assert_not_called()


def test_a_failed_build_says_why_and_where_its_log_is():
    with patch(
        "canyonos.kubernetes_target.kubectl_json",
        return_value={
            "status": {"phase": "Failed", "message": "error: No solution found"}
        },
    ):
        with pytest.raises(RuntimeError, match="No solution found") as raised:
            kubernetes_target.wait_for_build(
                "acme",
                "demo-t1",
                ("Succeeded",),
                60,
                sleep=lambda _: None,
                clock=lambda: 0,
            )
    assert "kubectl -n acme logs job/demo-t1 -c build" in str(raised.value)


@pytest.mark.parametrize("root", [".", ".canyon"])
def test_deploy_hands_the_project_to_the_cluster_and_only_uploads_it(
    tmp_path, monkeypatch, root
):
    monkeypatch.chdir(tmp_path)
    (tmp_path / root / "config").mkdir(parents=True)
    config_path = tmp_path / root / "config" / "global_controller.yaml"
    config_path.write_text(
        "agents: []\nendpoint: {agent: W, method: main}\n"
        "kubernetes: {namespace: acme, registry: localhost:5001}\n"
    )
    (tmp_path / ".env").write_text("OPENAI_API_KEY=sk-secret\n")
    applied, uploaded, deleted, phases = [], [], [], iter(["Receiving", "Succeeded"])

    def kubectl(args, **_):
        if args[:2] == ["delete", "canyonbuild"]:
            deleted.append(args[2])
        return SimpleNamespace(returncode=0, stdout="{}", stderr="")

    def wait(namespace, name, wanted, timeout):
        return {
            "phase": next(phases),
            "podName": "build-pod",
            "images": {"W": "r@sha256:x"},
        }

    with (
        patch("canyonos.kubernetes_target.require_operator"),
        patch("canyonos.kubernetes_target.ensure_namespace"),
        patch(
            "canyonos.kubernetes_target.apply",
            side_effect=lambda objs: applied.extend(objs),
        ),
        patch("canyonos.kubernetes_target.build_image", return_value=""),
        patch("canyonos.kubernetes_target.wait_for_build", side_effect=wait),
        patch(
            "canyonos.kubernetes_target.upload_project",
            side_effect=lambda ns, pod, archive: uploaded.append((pod, archive)),
        ),
        patch("canyonos.kubernetes_target.kubectl", side_effect=kubectl),
        patch(
            "canyonos.kubernetes_target.wait_until_ready",
            return_value=({"status": {}}, []),
        ) as wait_until_ready,
        patch("canyonos.kubernetes_target.ui"),
    ):
        kubernetes_target.run_kubernetes_deploy()

    kinds = [obj["kind"] for obj in applied]
    assert kinds == ["Secret", "CanyonBuild"], (
        "only the .env Secret and the build: the cluster applies the rest"
    )
    build = applied[1]
    # Named from the uploaded root, where the build runs, in both layouts.
    assert build["spec"]["config"] == "config/global_controller.yaml"
    # The project_id is written first, so even the first deploy is named after it, as
    # Docker names it. The build gets that name, which the cluster turns into the
    # CanyonProject's; the Secret and the wait use the same Kubernetes name.
    project_id = yaml.safe_load(config_path.read_text())["project_id"]
    project = f"{normalise(tmp_path.name)}-{project_id[:8]}"
    assert build["spec"]["project"] == project
    named = kubernetes_target.resource_name(project)
    assert build["spec"]["envSecretRef"] == f"{named}-env"
    assert wait_until_ready.call_args.args[:2] == ("acme", named)
    ((pod, archive),) = uploaded
    assert pod == "build-pod"
    import tarfile

    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        assert "config/global_controller.yaml" in tar.getnames()
    assert deleted == [build["metadata"]["name"]]
    assert "image" not in build["spec"], "the cluster's own core image"
    assert "apply" not in build["spec"], "a build always applies its project"
    assert yaml.safe_load(config_path.read_text())["project_id"], "saved, as on Docker"


def test_two_builds_in_the_same_second_get_their_own_names(monkeypatch):
    names = []
    monkeypatch.setattr(kubernetes_target.time, "strftime", lambda _: "20261028-101500")
    with (
        patch("canyonos.kubernetes_target.build_image", return_value=""),
        patch(
            "canyonos.kubernetes_target.apply",
            side_effect=lambda objs: names.append(objs[0]["metadata"]["name"]),
        ),
        patch(
            "canyonos.kubernetes_target.wait_for_build",
            return_value={"podName": "p", "images": {}},
        ),
        patch("canyonos.kubernetes_target.upload_project"),
        patch("canyonos.kubernetes_target.source_tarball", return_value=b""),
        patch("canyonos.kubernetes_target.kubectl"),
        patch("canyonos.kubernetes_target.ui"),
    ):
        for project in ("demo", "demo", "x" * 80):
            kubernetes_target.build_in_cluster(
                "config/global_controller.yaml",
                "acme",
                project,
                {"registry": "r"},
                None,
            )

    assert names[0] != names[1]
    assert all(len(n) <= 63 and "-20261028-101500-" in n for n in names)


def test_a_build_names_a_platform_only_when_the_project_does():
    k8s = {"namespace": "acme", "registry": "localhost:5001"}
    build = kubernetes_target.canyon_build(
        "b", "acme", "Demo", "c.yaml", k8s, "t1", "core", None
    )
    assert "platform" not in build["spec"], "the cluster builds for its own nodes"

    k8s["platform"] = "linux/arm64"
    build = kubernetes_target.canyon_build(
        "b", "acme", "Demo", "c.yaml", k8s, "t1", "core", None
    )
    assert build["spec"]["platform"] == "linux/arm64"


def test_the_upload_goes_straight_to_the_port_forward_past_any_proxy(monkeypatch):
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    received = []

    class Handler(BaseHTTPRequestHandler):
        def do_PUT(self):
            received.append(self.rfile.read(int(self.headers["Content-Length"])))
            self.send_response(200)
            self.end_headers()

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.handle_request, daemon=True).start()
    # A proxy that is not there: the upload fails if it is sent through it.
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:9")
    monkeypatch.setenv("http_proxy", "http://127.0.0.1:9")
    forward = SimpleNamespace(
        stdout=io.StringIO(f"Forwarding from 127.0.0.1:{server.server_port} -> 8090\n"),
        poll=lambda: None,
        terminate=lambda: None,
    )
    with patch("canyonos.kubernetes_target.subprocess.Popen", return_value=forward):
        kubernetes_target.upload_project("acme", "build-pod", b"archive", attempts=1)
    server.server_close()

    assert received == [b"archive"]


def test_a_port_forward_that_dropped_is_started_again():
    import socket
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    received = []

    class Handler(BaseHTTPRequestHandler):
        def do_PUT(self):
            received.append(self.rfile.read(int(self.headers["Content-Length"])))
            self.send_response(200)
            self.end_headers()

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.handle_request, daemon=True).start()
    # A port nothing listens on: where the first forward was, once kubectl ended it.
    with socket.socket() as closed:
        closed.bind(("127.0.0.1", 0))
        gone = closed.getsockname()[1]
    dropped = SimpleNamespace(
        stdout=io.StringIO(f"Forwarding from 127.0.0.1:{gone} -> 8090\n"),
        poll=lambda: 1,
        terminate=lambda: None,
    )
    fresh = SimpleNamespace(
        stdout=io.StringIO(f"Forwarding from 127.0.0.1:{server.server_port} -> 8090\n"),
        poll=lambda: None,
        terminate=lambda: None,
    )
    with patch(
        "canyonos.kubernetes_target.subprocess.Popen", side_effect=[dropped, fresh]
    ) as popen:
        kubernetes_target.upload_project(
            "acme", "build-pod", b"archive", sleep=lambda _: None
        )
    server.server_close()

    assert received == [b"archive"]
    assert popen.call_count == 2


def test_clean_never_deletes_the_namespace():
    for labels in ({kubernetes_target.LABEL_MANAGED_BY: "canyonos-cli"}, {}):
        calls = []

        def kubectl(args, **_):
            calls.append(args)
            namespace = {"metadata": {"labels": labels}}
            return SimpleNamespace(
                returncode=0, stdout=json.dumps(namespace), stderr=""
            )

        with (
            patch(
                "canyonos.kubernetes_target._namespace_and_project",
                return_value=("acme", "demo"),
            ),
            patch("canyonos.kubernetes_target.kubectl", side_effect=kubectl),
            patch("canyonos.kubernetes_target.ui") as ui,
        ):
            kubernetes_target.run_kubernetes_clean()

        assert not [c for c in calls if c[:2] == ["delete", "namespace"]]
        assert any(c[:2] == ["delete", "canyonproject"] for c in calls)
        assert ui.hint.called is bool(labels), "says how, for a namespace it made"


def test_a_private_registry_signs_in_both_to_push_and_to_pull():
    k8s = {
        "namespace": "acme",
        "registry": "r.example.com",
        "image_pull_secret": "regcred",
    }
    build = kubernetes_target.canyon_build(
        "b", "acme", "Demo", "c.yaml", k8s, "t1", "", None
    )

    assert build["spec"]["registrySecretRef"] == "regcred"
    assert build["spec"]["imagePullSecrets"] == [{"name": "regcred"}]
    assert "image" not in build["spec"] and "envSecretRef" not in build["spec"]


def test_the_build_runs_the_clusters_core_image_unless_developing(monkeypatch):
    monkeypatch.setattr(
        kubernetes_target.env, "core_image", kubernetes_target.env.PROD_CORE_IMAGE
    )
    assert kubernetes_target.build_image("localhost:5001", "t1") == "", (
        "a release uses the image the operator was installed with (a mirror, maybe)"
    )

    pushed = "localhost:5001/canyonos-core:pr"
    monkeypatch.setattr(kubernetes_target.env, "core_image", pushed)
    assert kubernetes_target.build_image("localhost:5001", "t1") == pushed

    monkeypatch.setattr(kubernetes_target.env, "core_image", "canyonos-core:dev")
    with patch(
        "canyonos.kubernetes_target._push_local_image",
        return_value="r/canyonos-core@sha256:d",
    ) as push:
        assert kubernetes_target.build_image("r", "t1") == "r/canyonos-core@sha256:d"
    push.assert_called_once_with("canyonos-core:dev", "r", "t1")


def test_the_operator_is_found_without_cluster_wide_rights():
    def kubectl(stdout):
        return patch(
            "canyonos.kubernetes_target.kubectl",
            return_value=SimpleNamespace(returncode=0, stdout=stdout, stderr=""),
        )

    resources = (
        "canyonprojects.canyonos.canyoncode.ai\ncanyonagents.canyonos.canyoncode.ai\n"
    )
    with kubectl(resources) as run:
        kubernetes_target.require_operator()
    assert run.call_args.args[0][0] == "api-resources", "discovery, not the CRDs"

    with kubectl(""), pytest.raises(RuntimeError, match="operator is not installed"):
        kubernetes_target.require_operator()


def test_a_namespace_one_may_not_read_is_used_not_created():
    forbidden = SimpleNamespace(
        returncode=1,
        stdout="",
        stderr='namespaces "acme" is forbidden: User cannot get',
    )
    with patch("canyonos.kubernetes_target.kubectl", return_value=forbidden) as run:
        assert kubernetes_target.ensure_namespace("acme") is False
    assert run.call_count == 1, "no create attempted"


def test_the_kubernetes_block_reads_variables_from_dotenv_only(tmp_path, monkeypatch):
    path = tmp_path / "global_controller.yaml"
    path.write_text(
        "kubernetes: {namespace: '${NS}', registry: '${REGISTRY}'}\n", encoding="utf-8"
    )
    monkeypatch.setenv("REGISTRY", "from-the-shell")

    k8s = kubernetes_target.load_config(str(path), {"NS": "acme"})["kubernetes"]

    assert k8s["namespace"] == "acme"
    assert k8s["registry"] == "${REGISTRY}", "the build in the cluster sees .env alone"


def test_a_refused_upload_fails_at_once():
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_PUT(self):
            requests.append(self.rfile.read(int(self.headers["Content-Length"])))
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"empty upload")

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    forward = SimpleNamespace(
        stdout=io.StringIO(f"Forwarding from 127.0.0.1:{server.server_port} -> 8090\n"),
        poll=lambda: None,
        terminate=lambda: None,
    )
    try:
        with (
            patch("canyonos.kubernetes_target.subprocess.Popen", return_value=forward),
            pytest.raises(
                RuntimeError, match=r"refused the upload \(400\): empty upload"
            ),
        ):
            kubernetes_target.upload_project(
                "acme", "build-pod", b"", sleep=lambda _: None
            )
    finally:
        server.shutdown()
        server.server_close()

    assert len(requests) == 1, "not retried"


def test_target_kubernetes_runs_the_kubernetes_command(monkeypatch):
    import contextlib

    import cli

    monkeypatch.setattr(
        sys, "argv", ["canyonos", "status", "--target", "kubernetes", "--json"]
    )
    with (
        patch.object(cli, "notify_if_outdated"),
        patch.object(cli, "recording_usage", lambda _: contextlib.nullcontext()),
        patch.object(cli, "run_status") as on_docker,
        patch(
            "canyonos.kubernetes_target.run_kubernetes_status", return_value=True
        ) as on_kubernetes,
        pytest.raises(SystemExit) as exited,
    ):
        cli._run_command()

    on_kubernetes.assert_called_once_with(True)
    on_docker.assert_not_called()
    assert exited.value.code == 0


def test_stop_and_clean_on_kubernetes_exit_zero_when_done(monkeypatch):
    import contextlib

    import cli

    for command in ("stop", "clean"):
        monkeypatch.setattr(
            sys, "argv", ["canyonos", command, "--target", "kubernetes"]
        )
        with (
            patch.object(cli, "notify_if_outdated"),
            patch.object(cli, "recording_usage", lambda _: contextlib.nullcontext()),
            patch(
                f"canyonos.kubernetes_target.run_kubernetes_{command}",
                return_value=True,
            ),
            pytest.raises(SystemExit) as exited,
        ):
            cli._run_command()
        assert exited.value.code == 0, command


def test_all_is_refused_on_kubernetes(monkeypatch):
    # --all means every project on this machine; a cluster has no such list.
    import contextlib

    import cli

    for command, local in (("stop", "run_stop"), ("clean", "run_clean")):
        monkeypatch.setattr(
            sys, "argv", ["canyonos", command, "--all", "--target", "kubernetes"]
        )
        with (
            patch.object(cli, "notify_if_outdated"),
            patch.object(cli, "recording_usage", lambda _: contextlib.nullcontext()),
            patch.object(cli, local) as on_docker,
            patch(f"canyonos.kubernetes_target.run_kubernetes_{command}") as on_cluster,
            pytest.raises(SystemExit) as exited,
        ):
            cli._run_command()
        assert exited.value.code == 1, command
        on_docker.assert_not_called()
        on_cluster.assert_not_called()


def _logs_argv(agent=None, follow=True, tail="200", pods=()):
    """The kubectl command `canyonos logs --target kubernetes` runs."""
    calls = []

    def kubectl(args, **_):
        found = args[:2] == ["get", "pod"] and args[2] in pods
        return SimpleNamespace(returncode=0 if found else 1, stdout="", stderr="")

    with (
        patch(
            "canyonos.kubernetes_target._namespace_and_project",
            return_value=("acme", "demo"),
        ),
        patch("canyonos.kubernetes_target.kubectl", side_effect=kubectl),
        patch(
            "canyonos.kubernetes_target.subprocess.call",
            side_effect=lambda argv: calls.append(argv) or 0,
        ),
    ):
        assert kubernetes_target.run_kubernetes_logs(follow, tail, agent)
    (argv,) = calls
    return argv


def test_logs_on_kubernetes_are_the_global_controllers_like_on_docker():
    argv = _logs_argv()
    assert argv[-2:] == ["-f", "deployment/canyonos-gc"]
    assert "--tail=200" in argv


def test_logs_of_one_replica_or_of_an_agent():
    assert (
        _logs_argv("IntentAgent-1", pods={"intentagent-1"})[-1] == "pod/intentagent-1"
    )
    agent = _logs_argv("IntentAgent", follow=False, tail="all")
    assert "-f" not in agent and "--tail=-1" in agent
    assert (
        f"{kubernetes_target.LABEL_PROJECT}=demo,{kubernetes_target.LABEL_AGENT}=intentagent"
        in agent
    )


def test_logs_refuse_a_tail_that_is_not_a_number():
    with pytest.raises(RuntimeError, match="--tail"):
        kubernetes_target.run_kubernetes_logs(tail="lots")


def test_status_json_has_the_shape_docker_status_json_has():
    project = {"status": {"endpointURL": "https://hello.example.com"}}
    agent = {
        "spec": {"agentName": "HelloAgent", "replicas": 2},
        "status": {
            "readyReplicas": 1,
            "conditions": [
                {"type": "Ready", "status": "False", "reason": "Unschedulable",
                 "message": "no node"}
            ],
        },
    }  # fmt: skip
    printed = []
    with (
        patch(
            "canyonos.kubernetes_target._namespace_and_project",
            return_value=("acme", "demo"),
        ),
        patch(
            "canyonos.kubernetes_target.kubectl",
            return_value=SimpleNamespace(
                returncode=0, stdout=json.dumps(project), stderr=""
            ),
        ),
        patch("canyonos.kubernetes_target.project_agents", return_value=[agent]),
        patch("builtins.print", side_effect=printed.append),
    ):
        assert kubernetes_target.run_kubernetes_status(as_json=True)

    report = json.loads(printed[-1])
    assert set(report) == {"running", "endpoint", "dashboard_url", "agents",
                           "machine_errors", "errors"}  # fmt: skip
    assert report["endpoint"] == {"url": "https://hello.example.com"}
    assert report["agents"] == {
        "HelloAgent": {
            "desired_replicas": 2,
            "running_replicas": 1,
            "launch_error": "no node",
        }
    }
