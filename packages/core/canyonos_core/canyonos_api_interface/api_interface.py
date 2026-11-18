# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""HTTP server that runs in the Global Controller container on Docker, holding its one
deployment, and beside the operator on Kubernetes, holding every deployment there; the
CLI uploads a deployment to it, a background loop per deployment starts, restarts,
reloads or stops its deploy to match, and the CLI reads the deploy's status, logs and
health from it."""

import base64
import hashlib
import hmac
import importlib.metadata
import json
import logging
import os
import shutil
import tarfile
import tempfile
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any

import yaml
from flask import Response, g, jsonify, request
from flask_openapi3 import Info, OpenAPI
from werkzeug.serving import run_simple

from canyonos_core.controller.controller_context import DEFAULT_REDIS_PORT
from canyonos_core.controller.orchestrator import TARGET_ENV
from canyonos_core.controller.utils import internal_ca, internal_tls
from canyonos_core.controller.utils.config_env import read_dotenv
from canyonos_core.controller.utils.container_names import (
    COLLECTOR_IMAGE,
    CONTROLLER_IMAGE,
)
from canyonos_core.controller.utils.redis_client import PASSWORD_ENV
from canyonos_core.kubernetes.receiver import MAX_UPLOAD_BYTES
from canyonos_core.schema import DEPLOYMENT_CONFIG
from canyonos_core.canyonos_api_interface.models import (
    TEXT,
    AgentPath,
    DashboardBody,
    DashboardProject,
    DeploymentBody,
    DeploymentPath,
    Deployments,
    Error,
    Generation,
    Health,
    LogsQuery,
    Project,
    ProjectArchive,
    ProjectPath,
    Projects,
    ReplicaLogs,
    Status,
    TailQuery,
    Uploaded,
)
from canyonos_core.validate import finding_text, validate_root
from canyonos_core.workspace_upload import (
    archive_digests,
    archive_entries,
    fingerprints,
    remove_stale_entries,
)

# Docker unless CANYONOS_TARGET is kubernetes, as the Global Controller's orchestrator.
KUBERNETES = os.environ.get(TARGET_ENV) == "kubernetes"
if KUBERNETES:
    from canyonos_core.canyonos_api_interface import kubernetes as target
    from canyonos_core.canyonos_api_interface.kubernetes import check_caller, restore
else:
    from canyonos_core.canyonos_api_interface import docker as target

# The deployment is uploaded here (into a named volume) by the PUT routes: its
# deployment.yaml and a folder per project. Deploy builds and launches against it.
# On Kubernetes each deployment has a folder in it, named by its deployment_id.
WORKSPACE_DIR = "/workspace"

# How long the upload must stay unchanged before the apply loop acts on it.
SETTLE_SECONDS = 2
# Not an upload, so the apply loop doesn't wait for it.
DASHBOARD_ROUTE = "/v1/deployments/<deployment_id>/dashboard"
# Just after a redeploy the dashboard api can 5xx, reaching for the old Redis, for ~30 s.
DASHBOARD_RETRY_SECONDS = 60
DASHBOARD_RETRY_DELAY_SECONDS = 2
DASHBOARD_TIMEOUT_SECONDS = 10
VERSION = importlib.metadata.version("canyonos-core")


def _bad_request(e):
    """Answer a request whose path, query or body doesn't match its model."""
    problems = "; ".join(
        f"{'.'.join(map(str, error['loc']))}: {error['msg']}" for error in e.errors()
    )
    response = jsonify({"error": problems, "code": "bad_request"})
    response.status_code = 400
    return response


app = OpenAPI(
    "canyonos-api-interface",
    info=Info(title="CanyonOS Global Controller", version=VERSION),
    validation_error_status=400,
    validation_error_model=Error,
    validation_error_callback=_bad_request,
    # Any route answers it for a deployment_id other than this server's.
    responses={404: Error},
)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES


@dataclass
class _Deployment:
    """One deployment this server holds: the folder it is uploaded to, the upload's
    entries and file digests, kept here, out of the user's files, the API key hash its
    endpoint checks, its upload PUTs in progress, its latest deploy's progress, and how
    far its apply loop got."""

    workspace: str
    name: str = ""
    project_entries: dict = field(default_factory=dict)
    project_digests: dict = field(default_factory=dict)
    deployment_digests: dict = field(default_factory=dict)
    auth: dict = field(default_factory=dict)
    puts_in_progress: int = 0
    generation: int = 0
    last_change: float = 0.0
    applied_generation: int = 0
    applying: str | None = None
    last_apply: Any = None
    deploy: Any = None
    # Held while its deploy is started, signalled or stopped.
    lock: Any = field(default_factory=threading.Lock)


# By deployment_id.
_deployments = {}
# Held while an upload changes; notified on each change, finished PUT and applied pass.
_changes = threading.Condition()


@app.before_request
def _count_put():
    """Count an upload PUT as in progress on the deployment it names from before its
    body is read; that deployment's apply loop waits until none is."""
    deployment = _deployments.get((request.view_args or {}).get("deployment_id"))
    if (
        request.method == "PUT"
        and str(request.url_rule) != DASHBOARD_ROUTE
        and deployment is not None
    ):
        with _changes:
            deployment.puts_in_progress += 1
        g.counted = deployment


@app.teardown_request
def _uncount_put(_error):
    """Stop counting a finished upload PUT and wake its deployment's apply loop."""
    if "counted" in g:
        with _changes:
            g.counted.puts_in_progress -= 1
            _changes.notify_all()


def _check_caller():
    """On Kubernetes, answer 401 unless the request's Bearer token signs a user in, and
    403 unless they may change, or for a GET read, CanyonProjects in the namespace of
    the deployment it names, as uploaded and as a PUT of its settings would make it."""
    deployment_id = (request.view_args or {}).get("deployment_id")
    configs = []
    if deployment_id in _deployments:
        path = os.path.join(_deployments[deployment_id].workspace, DEPLOYMENT_CONFIG)
        if os.path.isfile(path):
            with open(path, encoding="utf-8") as f:
                configs.append(f.read())
    if request.endpoint == "put_deployment":
        configs.append((request.get_json(silent=True) or {}).get("config") or "")
    return check_caller(
        request.headers.get("Authorization", ""),
        configs,
        "get" if request.method == "GET" else "update",
    )


def _check_secret():
    """On Docker, answer 401 unless the request sends `Authorization: Bearer <secret>`
    with the secret the CLI started this container with."""
    sent = request.headers.get("Authorization", "").encode()
    expected = f"Bearer {os.environ['CANYONOS_CONTROLLER_SECRET']}".encode()
    if not hmac.compare_digest(sent, expected):
        return jsonify(
            {
                "error": "Send the Authorization header saved in this deployment's "
                "~/.canyonos/deployments/<deployment>/state.json.",
                "code": "unauthenticated",
            }
        ), 401


# After `_count_put`, so a refused PUT is still counted once and uncounted once; before
# `_refuse_other_deployments`, so who may not call learns no deployment_id.
if KUBERNETES:
    app.before_request(_check_caller)
else:
    app.before_request(_check_secret)


@app.before_request
def _refuse_other_deployments():
    """Answer 404 to a route naming a deployment this server doesn't hold, except, on
    Kubernetes, the PUT of a new deployment's settings, which adds it."""
    deployment_id = (request.view_args or {}).get("deployment_id")
    # Not `.` or `..`: that deployment's folder would hold the other deployments'.
    adding = (
        KUBERNETES
        and request.endpoint == "put_deployment"
        and deployment_id not in (".", "..")
    )
    if deployment_id is not None and deployment_id not in _deployments and not adding:
        return jsonify(
            {
                "error": f"No deployment has the id {deployment_id}",
                "code": "unknown_deployment",
            }
        ), 404


def _record_change(deployment):
    """Bump `deployment`'s generation and wake its apply loop; call it holding
    `_changes`. Returns the new generation."""
    deployment.generation += 1
    deployment.last_change = time.monotonic()
    _changes.notify_all()
    return deployment.generation


def _apply_changes(deployment):
    """Once each run of `deployment`'s upload changes settles, start, restart, reload or
    stop its deploy to match the upload, and record the outcome. Runs on its own thread
    for the server's whole life."""
    while True:
        with _changes:
            _changes.wait_for(
                lambda: deployment.generation > deployment.applied_generation
            )
            while (
                deployment.puts_in_progress
                or time.monotonic() < deployment.last_change + SETTLE_SECONDS
            ):
                _changes.wait(SETTLE_SECONDS)
        while True:
            with _changes:
                generation = deployment.generation
                ready = (
                    DEPLOYMENT_CONFIG in deployment.deployment_digests
                    and deployment.project_entries
                )
                uploaded = fingerprints(
                    {
                        **deployment.deployment_digests,
                        **{
                            path: digest
                            for digests in deployment.project_digests.values()
                            for path, digest in digests.items()
                        },
                    }
                )
                uploaded["auth"] = deployment.auth
            progress = target.running_deploy(deployment.deploy)
            # A stop goes ahead; anything else waits for the deploy to finish starting.
            if not (ready and progress and progress.phase == "starting"):
                break
            # Checked each second, so a DELETE that comes meanwhile stops it right away.
            with progress.changed:
                progress.changed.wait_for(lambda: progress.phase != "starting", 1)
        with deployment.lock:
            progress = target.running_deploy(deployment.deploy)
            if not ready:
                action = "stop" if progress else "none"
            elif progress is None:
                action = "start"
            elif (
                uploaded["code"] != progress.deployed["code"]
                or uploaded["auth"] != progress.deployed["auth"]
            ):
                action = "restart"
            elif uploaded["config"] != progress.deployed["config"]:
                action = "reload"
            else:
                action = "none"
            deployment.applying = None if action == "none" else action
            failure = None
            if action in ("stop", "restart"):
                failure = target.stop(progress)
            if action == "start" or (action == "restart" and not failure):
                deployment.deploy = target.start(
                    deployment.workspace, deployment.name, uploaded, deployment.lock
                )
            elif action == "reload":
                failure = target.reload(progress, uploaded["config"])
        with _changes:
            deployment.applying = None
            deployment.applied_generation = generation
            deployment.last_apply = {
                "generation": generation,
                "action": action,
                "ok": not failure,
                "error": None,
                "code": None,
                **(failure or {}),
            }
            _changes.notify_all()


def _add_deployment(deployment_id, workspace):
    """Hold deployment `deployment_id`, uploaded to `workspace`, and start its apply
    loop. Returns it."""
    deployment = _deployments[deployment_id] = _Deployment(workspace)
    threading.Thread(target=_apply_changes, args=(deployment,), daemon=True).start()
    return deployment


if not KUBERNETES:
    _add_deployment(os.environ["CANYONOS_DEPLOYMENT_ID"], WORKSPACE_DIR)


@app.get(
    "/v1/deployments", summary="List the deployments", responses={200: Deployments}
)
def list_deployments():
    """Return the one deployment this server holds, with the name its last `PUT`
    gave it."""
    with _changes:
        deployments = [
            {"deployment_id": deployment_id, "name": deployment.name}
            for deployment_id, deployment in _deployments.items()
        ]
    return jsonify({"deployments": deployments}), 200


@app.put(
    "/v1/deployments/<deployment_id>",
    summary="Upload deployment.yaml and its .env",
    responses={200: Uploaded, 400: Error},
)
def put_deployment(path: DeploymentPath, body: DeploymentBody):
    """Write `deployment.yaml` and the `.env` beside it into `/workspace`, removing that
    `.env` when `env` is null, and keep `name` as the deployment's name. With
    `projects`, remove the uploaded projects it leaves out; with `api_key_hash`, keep
    it as the deployment's API key, none when it is empty."""
    with _changes:
        deployment = _deployments.get(path.deployment_id)
        # Only on Kubernetes, where its first `PUT` adds a deployment.
        if deployment is None:
            workspace = os.path.join(WORKSPACE_DIR, path.deployment_id)
            os.makedirs(workspace, exist_ok=True)
            deployment = _add_deployment(path.deployment_id, workspace)
        for file, text in {DEPLOYMENT_CONFIG: body.config, ".env": body.env}.items():
            full_path = os.path.join(deployment.workspace, file)
            if text is not None:
                with open(full_path, "w", encoding="utf-8") as f:
                    f.write(text)
                deployment.deployment_digests[file] = hashlib.sha256(
                    text.encode()
                ).hexdigest()
            elif deployment.deployment_digests.pop(file, None):
                os.remove(full_path)
        if body.projects is not None:
            for name in set(deployment.project_entries) - set(body.projects):
                _remove_project(deployment, name)
        if body.api_key_hash is not None:
            deployment.auth = (
                {"apiKeyHash": body.api_key_hash} if body.api_key_hash else {}
            )
        deployment.name = body.name
        generation = _record_change(deployment)
    return jsonify(
        {"generation": generation, "warnings": _collector_image_warnings(body.config)}
    ), 200


def _collector_image_warnings(config_text):
    """Machines other than this one run their metrics collector from the official
    release image; warn when this server runs another core image, such as a dev build,
    and `config_text` puts agents on such machines."""
    if CONTROLLER_IMAGE == COLLECTOR_IMAGE:
        return []
    try:
        config = yaml.safe_load(config_text)
    except yaml.YAMLError:
        config = None
    provider = config.get("provider") if isinstance(config, dict) else None
    if str(provider or "").casefold() not in ("ec2-pool", "ec2-assign"):
        return []
    return [
        f"Agent machines run the machine metrics collector from {COLLECTOR_IMAGE}, "
        f"not {CONTROLLER_IMAGE}: changes to it here don't reach them, and if "
        f"{VERSION} isn't published they report no machine metrics."
    ]


@app.delete(
    "/v1/deployments/<deployment_id>",
    summary="Stop the deploy and remove the upload",
    responses={200: Generation, 500: Error, 504: Error},
)
def delete_deployment(path: DeploymentPath):
    """Remove everything uploaded to `/workspace`, then wait for the apply loop to stop
    the deploy; 504 if it did not stop in time, 500 if stopping it failed."""
    deployment = _deployments[path.deployment_id]
    with _changes:
        deployment.name = ""
        for name, entries in deployment.project_entries.items():
            remove_stale_entries(os.path.join(deployment.workspace, name), entries, {})
        for file in deployment.deployment_digests:
            os.remove(os.path.join(deployment.workspace, file))
        for upload in (
            deployment.project_entries,
            deployment.project_digests,
            deployment.deployment_digests,
        ):
            upload.clear()
        generation = _record_change(deployment)
        _changes.wait_for(lambda: deployment.applied_generation >= generation)
        last_apply = deployment.last_apply
    if not last_apply["ok"]:
        return jsonify({"error": last_apply["error"], "code": last_apply["code"]}), (
            504 if last_apply["code"] == "stop_timeout" else 500
        )
    return jsonify({"generation": generation}), 200


@app.put(
    "/v1/deployments/<deployment_id>/projects/<name>",
    summary="Upload a project",
    responses={200: Uploaded, 400: Error},
)
def put_project(path: ProjectPath, raw: ProjectArchive):
    """Check the uploaded gzip tar of project `name` as `canyonos validate` does, then
    unpack it into `/workspace/<name>`, removing what its last upload had and this one
    lacks; on a 400 (bad archive, unsafe path or findings) the old files stay."""
    name, deployment = path.name, _deployments[path.deployment_id]
    with tempfile.TemporaryFile() as body, tempfile.TemporaryDirectory() as checked:
        shutil.copyfileobj(raw.stream, body)
        body.seek(0)
        try:
            with tarfile.open(fileobj=body, mode="r:gz") as archive:
                members = archive.getmembers()
                entries = archive_entries(members)
                digests = archive_digests(archive, members)
                archive.extractall(checked, members, filter="tar")
                findings = validate_root(checked)
                values = read_dotenv(os.path.join(checked, ".env"))
                unset = [
                    key
                    for key in read_dotenv(os.path.join(checked, ".env.example"))
                    if not values.get(key)
                ]
                if not findings:
                    project_dir = os.path.join(deployment.workspace, name)
                    remove_stale_entries(
                        project_dir, deployment.project_entries.get(name, {}), entries
                    )
                    archive.extractall(project_dir, members, filter="tar")
                    with _changes:
                        deployment.project_entries[name] = entries
                        deployment.project_digests[name] = {
                            f"{name}/{relative}": digest
                            for relative, digest in digests.items()
                        }
                        generation = _record_change(deployment)
        except (tarfile.TarError, EOFError, OSError, ValueError) as e:
            return jsonify(
                {
                    "error": f"Could not unpack the project: {e}",
                    "code": "bad_archive",
                }
            ), 400
    warnings = [
        f"Missing or empty in {name}/.env: {', '.join(unset)}. Agents that need them "
        "will fail."
    ]
    warnings = warnings if unset else []
    if findings:
        return jsonify(
            {
                "error": f"{name} was not uploaded: fix the errors `canyonos validate` "
                "reports, then rerun.",
                "code": "project_invalid",
                "findings": [
                    finding_text(
                        finding._replace(path=os.path.join(name, finding.path))
                    )
                    for finding in findings
                ],
                "warnings": warnings,
            }
        ), 400
    return jsonify({"generation": generation, "warnings": warnings}), 200


@app.delete(
    "/v1/deployments/<deployment_id>/projects/<name>",
    summary="Remove a project",
    responses={200: Generation, 400: Error, 404: Error},
)
def delete_project(path: ProjectPath):
    """Remove from `/workspace` what project `name`'s last upload put there; 404 if it
    was never uploaded."""
    deployment = _deployments[path.deployment_id]
    with _changes:
        if path.name not in deployment.project_entries:
            return jsonify(
                {"error": f"No project is named {path.name}", "code": "unknown_project"}
            ), 404
        _remove_project(deployment, path.name)
        generation = _record_change(deployment)
    return jsonify({"generation": generation}), 200


def _remove_project(deployment, name):
    """Remove from `deployment`'s folder what project `name`'s last upload put there,
    and forget that upload; call it holding `_changes`."""
    remove_stale_entries(
        os.path.join(deployment.workspace, name),
        deployment.project_entries.pop(name),
        {},
    )
    del deployment.project_digests[name]


@app.get(
    "/v1/deployments/<deployment_id>",
    summary="Read the deployment's status",
    responses={200: Status},
)
def status(path: DeploymentPath):
    """Report the deployment's name and `deployment.yaml` as last uploaded, how far the
    apply loop got, the deploy's phase, progress and verdict, and while it runs, its
    endpoint, agents and machine errors read from Redis; a part that could not be read
    is left null and named under `errors`."""
    deployment = _deployments[path.deployment_id]
    try:
        with open(
            os.path.join(deployment.workspace, DEPLOYMENT_CONFIG), encoding="utf-8"
        ) as f:
            config = f.read()
    except FileNotFoundError:
        config = None
    report = {
        "version": VERSION,
        "name": deployment.name,
        "config": config,
        "running": False,
        "phase": None,
        "message": None,
        "steps": [],
        "slowest_step": None,
        "idle_seconds": None,
        "error": None,
        "error_code": None,
        "root_cause": None,
        "endpoint": None,
        "agents": None,
        "machine_errors": None,
        "generation": deployment.generation,
        "applied_generation": deployment.applied_generation,
        "applying": deployment.applying,
        "last_apply": deployment.last_apply,
        "errors": [],
    }
    target.status(deployment.deploy, report)
    return jsonify(report), 200


@app.get(
    "/v1/deployments/<deployment_id>/logs/controller",
    summary="Read the controller log",
    responses={200: TEXT, 400: Error},
)
def controller_log(path: DeploymentPath, query: LogsQuery):
    """Return the deploy process's kept output, the last `tail` lines of it, as text;
    with `follow=true`, keep streaming new lines until the process has exited and every
    line was sent. Empty when nothing was deployed yet."""
    tail, progress = query.tail, _deployments[path.deployment_id].deploy
    if progress is None:
        return Response("", mimetype="text/plain")
    with progress.changed:
        lines, line_count = list(progress.lines), progress.line_count
    if tail != "all":
        lines = lines[max(len(lines) - int(tail), 0) :]
    if not query.follow:
        return Response("".join(lines), mimetype="text/plain")
    return Response(
        _follow_output(progress, line_count - len(lines)), mimetype="text/plain"
    )


def _follow_output(progress, sent):
    """Yield the deploy's output as it arrives, from line number `sent` on (counting
    lines no longer kept), until the deploy process has exited and every line was
    sent. Streams `GET /v1/deployments/<deployment_id>/logs/controller?follow=true`."""
    while True:
        with progress.changed:
            while progress.line_count == sent and not progress.finished:
                progress.changed.wait()
            unsent = min(progress.line_count - sent, len(progress.lines))
            batch = list(progress.lines)[len(progress.lines) - unsent :]
            sent, finished = progress.line_count, progress.finished
        yield "".join(batch)
        if finished:
            return


@app.get(
    "/v1/deployments/<deployment_id>/health",
    summary="Check the running deploy",
    responses={200: Health, 409: Error},
)
def health(path: DeploymentPath):
    """Check the running deploy's Global Controller, Redis, each agent's replica count
    and its endpoint, each with how to fix it when it fails; 409 if no deploy is
    running."""
    return target.health(_deployments[path.deployment_id].deploy)


def _project(deployment, name):
    """`deployment`'s uploaded project `name` as the projects routes answer it: its
    name, the fingerprints of its files and the query in its `config/test_query.txt`."""
    path = os.path.join(deployment.workspace, name, "config", "test_query.txt")
    try:
        with open(path, encoding="utf-8") as f:
            test_query = f.read().strip() or None
    except OSError:
        test_query = None
    return {
        "name": name,
        "fingerprints": fingerprints(deployment.project_digests[name]),
        "test_query": test_query,
    }


@app.get(
    "/v1/deployments/<deployment_id>/projects",
    summary="List the uploaded projects",
    responses={200: Projects},
)
def list_projects(path: DeploymentPath):
    """Return every uploaded project, by name."""
    deployment = _deployments[path.deployment_id]
    with _changes:
        projects = [
            _project(deployment, name) for name in sorted(deployment.project_digests)
        ]
    return jsonify({"projects": projects}), 200


@app.get(
    "/v1/deployments/<deployment_id>/projects/<name>",
    summary="Read a project",
    responses={200: Project, 400: Error, 404: Error},
)
def get_project(path: ProjectPath):
    """Return uploaded project `name`; 404 if it was never uploaded."""
    deployment = _deployments[path.deployment_id]
    with _changes:
        if path.name not in deployment.project_digests:
            return jsonify(
                {"error": f"No project is named {path.name}", "code": "unknown_project"}
            ), 404
        project = _project(deployment, path.name)
    return jsonify(project), 200


@app.get(
    "/v1/deployments/<deployment_id>/logs/agents/<name>",
    summary="Read an agent's replica logs",
    responses={200: ReplicaLogs, 400: Error, 404: Error, 409: Error, 503: Error},
)
def logs(path: AgentPath, query: TailQuery):
    """Return the last `tail` lines of each running replica of agent `name`, or of the
    one replica whose ID is `name`, read on its machine; 409 if no deploy is running,
    404 naming the agents when `name` is neither, 503 when Redis cannot be read."""
    return target.agent_logs(
        _deployments[path.deployment_id].deploy, path.name, query.tail
    )


@app.put(
    DASHBOARD_ROUTE,
    summary="Register the deployment's Redis with the dashboard",
    responses={200: DashboardProject, 400: Error, 502: Error},
)
def put_dashboard(path: DeploymentPath, body: DashboardBody):
    """Send this deployment's Redis host, port and password, plus a client certificate
    its CA signs when its Redis takes only TLS, to the dashboard api at `url` and
    return the project it registered. Connection failures and 5xx answers are retried
    for a minute; 502 when the api refuses it or never answers."""
    project = {
        "redis_host": os.environ["CANYONOS_REDIS_HOST"],
        "redis_port": DEFAULT_REDIS_PORT,
        "redis_password": os.environ[PASSWORD_ENV],
    }
    # Redis takes only TLS clients with a certificate the deployment's CA signed.
    if internal_ca.available():
        cert, key = internal_ca.sign(["dashboard"])
        project["redis_tls"] = {
            "ca": base64.b64decode(os.environ[internal_tls.CA_CERT_ENV]).decode(),
            "cert": cert.decode(),
            "key": key.decode(),
        }
    registration = urllib.request.Request(
        f"{body.url}/canyonos/projects",
        data=json.dumps(project).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    deadline = time.monotonic() + DASHBOARD_RETRY_SECONDS
    while True:
        try:
            with urllib.request.urlopen(
                registration, timeout=DASHBOARD_TIMEOUT_SECONDS
            ) as response:
                return jsonify(json.loads(response.read())), 200
        except urllib.error.HTTPError as e:
            failure = {"error": _dashboard_error(e), "code": "dashboard_refused"}
            if e.code < 500:
                break
        except (OSError, ValueError) as e:
            failure = {
                "error": f"the dashboard api did not answer: {e}",
                "code": "dashboard_unreachable",
            }
        if time.monotonic() > deadline:
            break
        time.sleep(DASHBOARD_RETRY_DELAY_SECONDS)
    return jsonify(failure), 502


def _dashboard_error(error):
    """The dashboard api's message from its `{error, message}` envelope, else the HTTP
    status."""
    try:
        body = json.loads(error.read())
    except (OSError, ValueError):
        body = None
    if isinstance(body, dict) and isinstance(body.get("message"), str):
        return body["message"]
    return f"the dashboard api answered HTTP {error.code}"


if __name__ == "__main__":
    # No banner or request lines among the deploy's output in the container's log.
    logging.getLogger("werkzeug").setLevel(logging.WARNING)
    if KUBERNETES:
        restore(_add_deployment, WORKSPACE_DIR)
    run_simple("0.0.0.0", 8000, app, threaded=True)
