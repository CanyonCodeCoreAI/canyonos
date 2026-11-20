# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The commands of a `target: kubernetes` workflow group reach the cluster's CanyonOS
API, through the installed command, each case in its own HOME. A stand-in `kubectl` on
PATH signs in with a token, records the port-forward it is asked for and serves the
"forwarded" API itself on the local port, answering what the case sets; a stand-in
`docker` reports nothing, so no cluster and no Docker are needed."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from .harness import CliCase

WORKFLOW_GROUP_ID = "5c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"
NAMESPACE = "team-a"
KUBE_TOKEN = "e2e-kube-token"
UPGRADE = (
    "Upgrade the CanyonOS operator chart: this CLI needs the CanyonOS API it installs"
)
FAKE_KUBECTL = """\
import json, os, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

here = os.environ["FAKE_KUBECTL_DIR"]
args = sys.argv[1:]
with open(os.path.join(here, "kubectl.jsonl"), "a") as log:
    log.write(json.dumps(args) + "\\n")
if args[:2] == ["config", "view"]:
    user_path = os.path.join(here, "user.json")
    if os.path.exists(user_path):
        user = json.load(open(user_path))
    else:
        user = {"token": "%(token)s"}
    print(json.dumps({"users": [{"user": user}]}))
elif args[:2] == ["config", "current-context"]:
    print("kind-e2e")
elif "port-forward" in args:
    local, remote = args[-1].split(":")
    answers = json.load(open(os.path.join(here, "answers.json")))

    class Api(BaseHTTPRequestHandler):
        def answer(self):
            with open(os.path.join(here, "requests.jsonl"), "a") as log:
                log.write(json.dumps({
                    "method": self.command,
                    "path": self.path,
                    "authorization": self.headers.get("Authorization"),
                }) + "\\n")
            status, body = answers[self.command]
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        do_GET = do_PUT = do_DELETE = answer

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", int(local)), Api)
    print(f"Forwarding from 127.0.0.1:{local} -> {remote}", flush=True)
    server.serve_forever()
else:
    print(f"error: the stand-in kubectl does not know {args}", file=sys.stderr)
    sys.exit(1)
""" % {"token": KUBE_TOKEN}


def _said(result: subprocess.CompletedProcess[str]) -> str:
    return " ".join((result.stdout + result.stderr).split())


def _kubernetes_group(
    case: CliCase, answers: dict, user: dict | None = None
) -> tuple[dict[str, str], Path]:
    """Write a `target: kubernetes` workflow group in the case's folder and the
    stand-in `kubectl` and `docker`, the API answering `answers` (by method, a status
    and a JSON body) and the kubeconfig's user signing in as `user` (a token by
    default); return the environment that puts them on PATH and the folder the
    stand-in records into."""
    (case.cwd / "workflow_group.yaml").write_text(
        f"workflow_group_id: {WORKFLOW_GROUP_ID}\n"
        "target: kubernetes\n"
        f"kubernetes:\n  namespace: {NAMESPACE}\n  registry: localhost:5001\n"
    )
    bin_dir = case.root / "bin"
    bin_dir.mkdir()
    kubectl = bin_dir / "kubectl"
    kubectl.write_text(f"#!{sys.executable}\n{FAKE_KUBECTL}")
    docker = bin_dir / "docker"
    docker.write_text("#!/bin/sh\nexit 1\n")
    for tool in (kubectl, docker):
        tool.chmod(0o755)
    records = case.root / "kubectl"
    records.mkdir()
    (records / "answers.json").write_text(json.dumps(answers))
    if user is not None:
        (records / "user.json").write_text(json.dumps(user))
    environment = {
        "PATH": f"{bin_dir}{os.pathsep}{case.env['PATH']}",
        "FAKE_KUBECTL_DIR": str(records),
    }
    return environment, records


def _lines(path: Path) -> list:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def _port_forwards(records: Path) -> list[list[str]]:
    return [
        args for args in _lines(records / "kubectl.jsonl") if "port-forward" in args
    ]


@pytest.fixture
def close_forwards(cli_case: CliCase):
    """End the detached forward processes a case leaves, as `canyonos stop` does: each
    one stops its kubectl once its record is gone."""
    yield
    forwards = cli_case.home / ".canyonos" / "forwards"
    for record in forwards.glob("*.json"):
        record.unlink()
    deadline = time.monotonic() + 15
    while list(forwards.glob("*.pid")) and time.monotonic() < deadline:
        time.sleep(0.2)


def _assert_forwarded_to_the_dashboard_api(records: Path) -> None:
    forwards = _port_forwards(records)
    assert forwards, _lines(records / "kubectl.jsonl")
    args = forwards[0]
    assert args[:2] == ["--context", "kind-e2e"], args
    assert args[2:6] == [
        "port-forward",
        "-n",
        "canyonos-dashboard",
        "svc/canyonos-dashboard-api",
    ], args
    local, remote = args[6].split(":")
    assert remote == "3000", args
    # 8000 first; the next free one when something here holds it.
    assert int(local) >= 8000, args


def test_status_reaches_the_cluster_api_through_the_dashboard_api_forward(
    cli_case: CliCase, close_forwards
):
    environment, records = _kubernetes_group(
        cli_case,
        {
            "GET": [
                404,
                {
                    "error": "workflow_groups.unknown_workflow_group",
                    "message": f'Workflow group "{WORKFLOW_GROUP_ID}" was not found',
                },
            ]
        },
    )

    result = cli_case.run_cli(["status", "--json"], env=environment, timeout=60)

    # 3: no deploy of this workflow group runs.
    assert result.returncode == 3, _said(result)
    report = json.loads(result.stdout)
    assert report["target"] == "kubernetes" and not report["running"], report
    assert report["errors"] == [], report
    _assert_forwarded_to_the_dashboard_api(records)
    assert _lines(records / "requests.jsonl") == [
        {
            "method": "GET",
            "path": f"/v1/workflow-groups/{WORKFLOW_GROUP_ID}",
            "authorization": f"Bearer {KUBE_TOKEN}",
        }
    ]


UNKNOWN_GROUP = {
    "GET": [
        404,
        {
            "error": "workflow_groups.unknown_workflow_group",
            "message": f'Workflow group "{WORKFLOW_GROUP_ID}" was not found',
        },
    ]
}


def test_a_token_file_signs_in_with_the_token_in_it(cli_case: CliCase, close_forwards):
    # A pod's ServiceAccount, as a platform deploying from inside the cluster signs in.
    token_file = cli_case.root / "serviceaccount-token"
    token_file.write_text("e2e-file-token\n")
    environment, records = _kubernetes_group(
        cli_case, UNKNOWN_GROUP, user={"tokenFile": str(token_file)}
    )

    result = cli_case.run_cli(["status", "--json"], env=environment, timeout=60)

    assert result.returncode == 3, _said(result)
    _assert_forwarded_to_the_dashboard_api(records)
    assert [r["authorization"] for r in _lines(records / "requests.jsonl")] == [
        "Bearer e2e-file-token"
    ]


def test_a_context_without_a_token_fails_and_says_so(cli_case: CliCase):
    environment, records = _kubernetes_group(
        cli_case,
        UNKNOWN_GROUP,
        user={"client-certificate-data": "Y2VydA==", "client-key-data": "a2V5"},
    )

    result = cli_case.run_cli(["status", "--json"], env=environment, timeout=60)

    assert result.returncode == 1, _said(result)
    assert "signs in without a token" in _said(result), _said(result)
    assert _port_forwards(records) == []


@pytest.mark.parametrize(
    ("status", "body"),
    [
        (
            503,
            {
                "error": "docker.disabled",
                "message": "This API runs without Docker: DOCKER_SOCKET is empty, so "
                "it drives no workflow group here",
            },
        ),
        (404, {"error": "not_found", "message": "Resource not found"}),
    ],
    ids=["docker-disabled", "no-v1-routes"],
)
def test_an_older_chart_api_names_the_chart_upgrade(
    cli_case: CliCase, close_forwards, status: int, body: dict
):
    environment, records = _kubernetes_group(cli_case, {"GET": [status, body]})

    result = cli_case.run_cli(["status", "--json"], env=environment, timeout=60)

    assert result.returncode == 1, _said(result)
    (error,) = json.loads(result.stdout)["errors"]
    assert UPGRADE in error, error
    assert body["message"] in error, error
    _assert_forwarded_to_the_dashboard_api(records)


def test_stop_deletes_the_workflow_group_and_closes_the_forward(cli_case: CliCase):
    environment, records = _kubernetes_group(
        cli_case, {"DELETE": [200, {"workflow_group_id": WORKFLOW_GROUP_ID}]}
    )

    result = cli_case.run_cli(["stop"], env=environment, timeout=60)

    assert result.returncode == 0, _said(result)
    assert "Stopped" in _said(result), _said(result)
    _assert_forwarded_to_the_dashboard_api(records)
    assert _lines(records / "requests.jsonl") == [
        {
            "method": "DELETE",
            "path": f"/v1/workflow-groups/{WORKFLOW_GROUP_ID}",
            "authorization": f"Bearer {KUBE_TOKEN}",
        }
    ]
    forwards = cli_case.home / ".canyonos" / "forwards"
    assert not list(forwards.glob("api.*")), list(forwards.iterdir())


def test_stop_in_a_workflow_folder_reaches_its_workflow_group_s_cluster(
    cli_case: CliCase,
):
    """Run from the workflow folder of a recorded `target: kubernetes` workflow group,
    `stop` reads the record's target and stops it on the cluster, not on Docker."""
    environment, records = _kubernetes_group(
        cli_case, {"DELETE": [200, {"workflow_group_id": WORKFLOW_GROUP_ID}]}
    )
    seed = cli_case.cwd / "workflow_group.yaml"
    folder = cli_case.cwd / "echo"
    folder.mkdir()
    record = (
        cli_case.home / ".canyonos" / "workflows" / f"group-{WORKFLOW_GROUP_ID[:8]}"
    )
    record.mkdir(parents=True)
    workflows = f"workflows:\n  echo-1a2b3c4d:\n    path: {folder}\n"
    (record / "workflow_group.yaml").write_text(seed.read_text() + workflows)
    seed.unlink()

    result = cli_case.run_cli(["stop"], env=environment, cwd=folder, timeout=60)

    assert result.returncode == 0, _said(result)
    assert [request["method"] for request in _lines(records / "requests.jsonl")] == [
        "DELETE"
    ], _said(result)
