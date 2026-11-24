# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The commands of a `target: kubernetes` workflow group reach the cluster's CanyonOS
API, through the installed command, each case in its own HOME. A stand-in `kubectl` on
PATH signs in with a token, records the port-forward it is asked for and serves the
"forwarded" API itself on the local port, answering what the case sets and keeping the
last archive uploaded for each workflow; a stand-in `docker` reports nothing, so no
cluster and no Docker are needed. That makes a deploy to the cluster the one deploy
that runs here in full, so it is where the upload of each workflow is checked: the
config its workflow group's record keeps, the local files it leaves out, and the hash
of the API key the workflow group's record keeps."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time
from pathlib import Path

import pytest
import yaml

from .harness import CliCase, workflow_config_dir

WORKFLOW_GROUP_ID = "5c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"
NAMESPACE = "team-a"
KUBE_TOKEN = "e2e-kube-token"
UPGRADE = (
    "Upgrade the CanyonOS operator chart: this CLI needs the CanyonOS API it installs"
)
# What the API answers a deploy or sync: the upload is applied as a reload.
APPLIED = {
    "running": True,
    "phase": "up",
    "generation": 1,
    "applied_generation": 1,
    "last_apply": {"ok": True, "action": "reload", "error": None, "code": None},
}
UPLOADED = {"generation": 1, "warnings": []}
MANIFEST = "agents:\n  - name: Echo\n    entrypoint: agents/echo.py\n"
CODE = "class Echo:\n    pass\n"
WORKFLOW_ENV = "ECHO_GREETING=hi\n"
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
            length = int(self.headers.get("Content-Length") or 0)
            upload = self.rfile.read(length) if length else b""
            json_body = self.headers.get("Content-Type") == "application/json"
            request = {
                "method": self.command,
                "path": self.path,
                "authorization": self.headers.get("Authorization"),
            }
            if json_body and upload:
                request["body"] = json.loads(upload)
            with open(os.path.join(here, "requests.jsonl"), "a") as log:
                log.write(json.dumps(request) + "\\n")
            if self.command == "PUT" and "/workflows/" in self.path:
                name = self.path.rsplit("/", 1)[1]
                with open(os.path.join(here, name + ".tar.gz"), "wb") as kept:
                    kept.write(upload)
            # A list under "<method> <path>" is answered in order, its last answer
            # again once it runs out; any other request gets its method's answer.
            listed = answers.get(f"{self.command} {self.path.split('?')[0]}")
            if listed:
                count = os.path.join(here, "answered.json")
                answered = json.load(open(count)) if os.path.exists(count) else {}
                key = f"{self.command} {self.path.split('?')[0]}"
                answered[key] = answered.get(key, 0) + 1
                json.dump(answered, open(count, "w"))
                status, body = listed[min(answered[key], len(listed)) - 1]
            else:
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


def _workflow(folder: Path) -> None:
    """Write a workflow into `folder`: one agent, which sets none of its resources,
    its code, a test query and a `.env`."""
    (folder / "config").mkdir(parents=True)
    (folder / "config" / "workflow_config.yaml").write_text(MANIFEST)
    (folder / "config" / "test_query.txt").write_text("from the folder\n")
    (folder / "agents").mkdir()
    (folder / "agents" / "echo.py").write_text(CODE)
    (folder / ".env").write_text(WORKFLOW_ENV)


def _upload_path(records: Path, config: Path) -> Path:
    """Where the stand-in keeps the archive last uploaded for the workflow whose record
    keeps `config`. Uploads go by workflow_id, which the workflow group's `workflows:`
    keeps by the workflow's name."""
    group = yaml.safe_load((config.parent.parent / "workflow_group.yaml").read_text())
    workflow_id = group["workflows"][config.parent.name]["workflow_id"]
    return records / f"{workflow_id}.tar.gz"


def _uploaded(records: Path, config: Path) -> dict[str, str]:
    """Each file of the archive last uploaded for the workflow whose record keeps
    `config`, by its path in the archive. The archive is removed, so the next read
    shows a later upload or fails."""
    path = _upload_path(records, config)
    with tarfile.open(path) as archive:
        files = {
            member.name: archive.extractfile(member).read().decode()
            for member in archive.getmembers()
            if member.isfile()
        }
    path.unlink()
    return files


def test_a_deploy_uploads_the_config_the_workflow_group_s_record_keeps(
    cli_case: CliCase, close_forwards
):
    """A workflow's first deploy copies its folder's `config/` into the workflow
    group's record, and the resource picker fills in that copy, leaving the folder's
    as written. From then on a deploy or sync uploads the record's copy with the
    folder's code and `.env`: a change made in the record is uploaded, one made only
    in the folder is warned of and left out (an untouched folder is not, though the
    picker filled in the record's copy), and once the folder's `config/` is gone a
    redeploy still uploads the record's. Replacing the workflow group's workflows
    removes the copy of the one it drops."""
    environment, records = _kubernetes_group(
        cli_case, {"GET": [200, APPLIED], "PUT": [200, UPLOADED]}
    )
    alpha, beta = cli_case.cwd / "alpha", cli_case.cwd / "beta"
    for folder in (alpha, beta):
        _workflow(folder)

    def run(*args: str) -> str:
        result = cli_case.run_cli(list(args), env=environment, timeout=60)
        assert result.returncode == 0, _said(result)
        return _said(result)

    first = run("deploy", "alpha", "--yes", "--detach")

    config = workflow_config_dir(cli_case, alpha)
    assert f"{config.parent.name}'s config now lives in {config}" in first, first
    assert (alpha / "config" / "workflow_config.yaml").read_text() == MANIFEST
    [echo] = yaml.safe_load((config / "workflow_config.yaml").read_text())["agents"]
    assert echo["replicas"] == 1 and echo["resources"]["memory"] == 512, echo
    assert _uploaded(records, config) == {
        "agents/echo.py": CODE,
        "config/workflow_config.yaml": (config / "workflow_config.yaml").read_text(),
        "config/test_query.txt": "from the folder\n",
        ".env": WORKFLOW_ENV,
    }

    untouched = run("sync", "alpha")
    assert "changed since" not in " ".join(untouched.split()), untouched

    (config / "test_query.txt").write_text("from the record\n")
    (alpha / "config" / "test_query.txt").write_text("edited in the folder\n")
    (alpha / "config" / "llms.yaml").write_text("models: {}\n")
    synced = run("sync", "alpha")

    assert (
        f"{alpha / 'config'} changed since {config.parent.name} was first deployed, "
        f"so it is not deployed: {config} is"
    ) in " ".join(synced.split()), synced
    uploaded = _uploaded(records, config)
    assert uploaded["config/test_query.txt"] == "from the record\n", uploaded
    assert "config/llms.yaml" not in uploaded, uploaded
    assert not (config / "llms.yaml").exists()

    shutil.rmtree(alpha / "config")
    run("deploy", "alpha", "--yes", "--detach")

    uploaded = _uploaded(records, config)
    assert uploaded["config/test_query.txt"] == "from the record\n", uploaded
    assert uploaded["agents/echo.py"] == CODE, uploaded

    record = config.parent.parent
    run("deploy", "--workflow-group", record.name, "beta", "--yes", "--detach")

    assert not config.parent.exists(), list(record.iterdir())
    kept = workflow_config_dir(cli_case, beta)
    assert kept.parent.parent == record, kept
    assert (
        _uploaded(records, kept)["config/workflow_config.yaml"]
        == (kept / "workflow_config.yaml").read_text()
    )


def test_a_deploy_hands_the_cluster_the_hash_of_the_workflow_group_s_key(
    cli_case: CliCase, close_forwards
):
    """`--api-key` keeps the key in the workflow group's record and the deploy hands the
    cluster's API only its SHA-256, signed in with the Kubernetes login, never the key;
    a redeploy keeps it, and `--no-api-key` hands an empty hash and removes it."""
    environment, records = _kubernetes_group(
        cli_case, {"GET": [200, APPLIED], "PUT": [200, UPLOADED]}
    )
    _workflow(cli_case.cwd / "alpha")
    key = "e2e-kubernetes-group-key"

    def deployed_hashes(*args: str) -> list:
        (records / "requests.jsonl").unlink(missing_ok=True)
        result = cli_case.run_cli(
            ["deploy", "alpha", "--yes", "--detach", *args], env=environment, timeout=60
        )
        said = _said(result)
        assert result.returncode == 0, said
        assert key not in result.stdout + result.stderr, said
        requests = _lines(records / "requests.jsonl")
        assert {request["authorization"] for request in requests} == {
            f"Bearer {KUBE_TOKEN}"
        }, requests
        return [
            request["body"]["api_key_hash"]
            for request in requests
            if request["method"] == "PUT" and "api_key_hash" in request.get("body", {})
        ]

    assert deployed_hashes("--api-key", key) == [
        hashlib.sha256(key.encode()).hexdigest()
    ]
    record = workflow_config_dir(cli_case, cli_case.cwd / "alpha").parent.parent
    assert (record / "api_key").read_text().strip() == key
    assert deployed_hashes() == [hashlib.sha256(key.encode()).hexdigest()]
    assert deployed_hashes("--no-api-key") == [""]
    assert not (record / "api_key").exists()


def test_a_deploy_leaves_local_files_out_of_the_upload(
    cli_case: CliCase, close_forwards
):
    """A deploy uploads neither git history, a virtualenv, installed packages nor
    bytecode, at any depth, nor any `.env*` file but the workflow's own `.env`, and the
    `.env.example` beside it, in the folder or in the config its record keeps, whatever
    the case of their names; the workflow's code, its `.env` and the record's config
    still arrive."""
    environment, records = _kubernetes_group(
        cli_case, {"GET": [200, APPLIED], "PUT": [200, UPLOADED]}
    )
    alpha = cli_case.cwd / "alpha"
    _workflow(alpha)
    local_files = {
        ".git/HEAD": "ref: refs/heads/main\n",
        ".venv/pyvenv.cfg": "home = /usr/bin\n",
        "node_modules/left-pad/index.js": "module.exports = 1;\n",
        "agents/__pycache__/echo.cpython-312.pyc": "bytecode\n",
        "sub/lib/__pycache__/util.cpython-312.pyc": "bytecode\n",
        ".env.local": "API_KEY=from-env-local\n",
        "sub/.env": "API_KEY=from-sub-env\n",
        ".ENV.prod": "API_KEY=from-env-prod\n",
        "sub/__PyCache__/mod.cpython-312.pyc": "bytecode\n",
        # Copied into the record by the first deploy, as the folder's config/ is.
        "config/__pycache__/hook.cpython-312.pyc": "bytecode\n",
        "config/.env.local": "API_KEY=from-config-env\n",
    }
    for relative, text in local_files.items():
        (alpha / relative).parent.mkdir(parents=True, exist_ok=True)
        (alpha / relative).write_text(text)
    (alpha / "sub" / "lib" / "util.py").write_text(CODE)
    (alpha / ".env.example").write_text("ECHO_GREETING=\n")

    result = cli_case.run_cli(
        ["deploy", "alpha", "--yes", "--detach"], env=environment, timeout=60
    )

    assert result.returncode == 0, _said(result)
    config = workflow_config_dir(cli_case, alpha)
    assert (config / "__pycache__").is_dir(), list(config.iterdir())
    with tarfile.open(_upload_path(records, config)) as archive:
        paths = archive.getnames()
    left_out = (".git", ".venv", "node_modules", "__pycache__")
    assert not [
        path
        for path in paths
        if any(part.casefold() in left_out for part in path.split("/"))
        or (
            path.rsplit("/", 1)[-1].casefold().startswith(".env")
            and path not in (".env", ".env.example")
        )
    ], paths
    uploaded = _uploaded(records, config)
    assert uploaded == {
        "agents/echo.py": CODE,
        "sub/lib/util.py": CODE,
        "config/workflow_config.yaml": (config / "workflow_config.yaml").read_text(),
        "config/test_query.txt": "from the folder\n",
        ".env": WORKFLOW_ENV,
        ".env.example": "ECHO_GREETING=\n",
    }, uploaded


def test_a_deploy_that_is_up_waits_for_its_endpoint(cli_case: CliCase, close_forwards):
    """The CanyonOS API reads a deploy's endpoint from its Redis only once the deploy is
    up, and that first read can fail. A deploy whose first `up` status has no endpoint
    and names why polls on until one has it, and prints that endpoint, not a warning
    that it could not be read."""
    status_path = f"/v1/workflow-groups/{WORKFLOW_GROUP_ID}"
    unread = {
        **APPLIED,
        "message": None,
        "steps": ["Build complete", "1 agent(s) ready"],
        "slowest_step": None,
        "idle_seconds": 1,
        "error": None,
        "error_code": None,
        "root_cause": None,
        "agents": None,
        "machine_errors": None,
        "endpoint": None,
        "errors": [
            "Could not read the deploy's state in Redis: The running controller "
            "could not be reached"
        ],
    }
    endpoint = {
        "public_host": "10.0.0.7",
        "api_port": 8080,
        "routes": [
            {
                "workflow": "alpha",
                "workflow_id": "alpha",
                "agent": "Echo",
                "method": "POST",
                "arguments": ["query"],
                "url": "http://10.0.0.7:8080/alpha",
            }
        ],
    }
    environment, records = _kubernetes_group(
        cli_case,
        {
            "GET": [200, unread],
            "PUT": [200, UPLOADED],
            f"GET {status_path}": [
                [200, unread],
                [200, unread],
                [200, {**unread, "endpoint": endpoint, "errors": []}],
            ],
        },
    )
    _workflow(cli_case.cwd / "alpha")

    result = cli_case.run_cli(
        ["deploy", "alpha", "--yes", "--serve", "false"], env=environment, timeout=90
    )

    said = _said(result)
    assert result.returncode == 0, said
    assert "Could not read the running workflow group's endpoint" not in said, said
    assert "/alpha -H" in said, said
    reads = [
        request
        for request in _lines(records / "requests.jsonl")
        if request["method"] == "GET" and request["path"].split("?")[0] == status_path
    ]
    assert len(reads) >= 3, reads


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
