# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""HTTP server that runs in the Global Controller container on Docker, holding its one
workflow group, and beside the operator on Kubernetes, holding every workflow group
there; the CLI uploads a workflow group to it, a background loop per workflow group
starts, restarts, reloads or stops its deploy to match, and the CLI reads the deploy's
status, logs and health from it."""

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
    DashboardWorkflows,
    Error,
    Generation,
    Health,
    LogsQuery,
    ReplicaLogs,
    Status,
    TailQuery,
    Uploaded,
    Workflow,
    WorkflowArchive,
    WorkflowGroupBody,
    WorkflowGroupPath,
    WorkflowGroups,
    WorkflowPath,
    Workflows,
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

# The workflow group is uploaded here (into a named volume) by the PUT routes: its
# workflow_group.yaml and a folder per workflow. Deploy builds and launches against it.
# On Kubernetes each workflow group has a folder in it, named by its workflow_group_id.
WORKSPACE_DIR = "/workspace"

# How long the upload must stay unchanged before the apply loop acts on it.
SETTLE_SECONDS = 2
# Not an upload, so the apply loop doesn't wait for it.
DASHBOARD_ROUTE = "/v1/workflow-groups/<workflow_group_id>/dashboard"
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
    # Any route answers 400 for a request it can't read, and 404 for a
    # workflow_group_id other than this server's.
    responses={400: Error, 404: Error},
)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES


@dataclass
class _WorkflowGroup:
    """One workflow group this server holds: the folder it is uploaded to, the upload's
    entries and file digests, kept here, out of the user's files, the API key hash its
    endpoint checks, its upload PUTs in progress, its latest deploy's progress, and how
    far its apply loop got."""

    workspace: str
    name: str = ""
    workflow_entries: dict = field(default_factory=dict)
    workflow_digests: dict = field(default_factory=dict)
    workflow_group_digests: dict = field(default_factory=dict)
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


# By workflow_group_id.
_workflow_groups = {}
# Held while an upload changes; notified on each change, finished PUT and applied pass.
_changes = threading.Condition()


@app.before_request
def _count_put():
    """Count an upload PUT as in progress on the workflow group it names from before
    its body is read; that workflow group's apply loop waits until none is."""
    workflow_group = _workflow_groups.get(
        (request.view_args or {}).get("workflow_group_id")
    )
    if (
        request.method == "PUT"
        and str(request.url_rule) != DASHBOARD_ROUTE
        and workflow_group is not None
    ):
        with _changes:
            workflow_group.puts_in_progress += 1
        g.counted = workflow_group


@app.teardown_request
def _uncount_put(_error):
    """Stop counting a finished upload PUT and wake its workflow group's apply loop."""
    if "counted" in g:
        with _changes:
            g.counted.puts_in_progress -= 1
            _changes.notify_all()


def _check_caller():
    """On Kubernetes, answer 401 unless the request's Bearer token signs a user in, and
    403 unless they may change, or for a GET read, CanyonProjects in the namespace of
    the workflow group it names, as uploaded and as a PUT of its settings would make
    it."""
    workflow_group_id = (request.view_args or {}).get("workflow_group_id")
    configs = []
    if workflow_group_id in _workflow_groups:
        path = os.path.join(
            _workflow_groups[workflow_group_id].workspace, DEPLOYMENT_CONFIG
        )
        if os.path.isfile(path):
            with open(path, encoding="utf-8") as f:
                configs.append(f.read())
    if request.endpoint == "put_workflow_group":
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
                "error": "Send the Authorization header saved in this workflow group's "
                "~/.canyonos/deployments/<workflow group>/state.json.",
                "code": "unauthenticated",
            }
        ), 401


# After `_count_put`, so a refused PUT is still counted once and uncounted once; before
# `_refuse_other_workflow_groups`, so who may not call learns no workflow_group_id.
if KUBERNETES:
    app.before_request(_check_caller)
else:
    app.before_request(_check_secret)


@app.before_request
def _refuse_other_workflow_groups():
    """Answer 404 to a route naming a workflow group this server doesn't hold, except,
    on Kubernetes, the PUT of a new workflow group's settings, which adds it."""
    workflow_group_id = (request.view_args or {}).get("workflow_group_id")
    # Not `.` or `..`: that workflow group's folder would hold the other ones'.
    adding = (
        KUBERNETES
        and request.endpoint == "put_workflow_group"
        and workflow_group_id not in (".", "..")
    )
    if (
        workflow_group_id is not None
        and workflow_group_id not in _workflow_groups
        and not adding
    ):
        return jsonify(
            {
                "error": f"No workflow group has the id {workflow_group_id}",
                "code": "unknown_workflow_group",
            }
        ), 404


def _record_change(workflow_group):
    """Bump `workflow_group`'s generation and wake its apply loop; call it holding
    `_changes`. Returns the new generation."""
    workflow_group.generation += 1
    workflow_group.last_change = time.monotonic()
    _changes.notify_all()
    return workflow_group.generation


def _apply_changes(workflow_group):
    """Once each run of `workflow_group`'s upload changes settles, start, restart,
    reload or stop its deploy to match the upload, and record the outcome. Runs on its
    own thread for the server's whole life."""
    while True:
        with _changes:
            _changes.wait_for(
                lambda: workflow_group.generation > workflow_group.applied_generation
            )
            while (
                workflow_group.puts_in_progress
                or time.monotonic() < workflow_group.last_change + SETTLE_SECONDS
            ):
                _changes.wait(SETTLE_SECONDS)
        while True:
            with _changes:
                generation = workflow_group.generation
                ready = (
                    DEPLOYMENT_CONFIG in workflow_group.workflow_group_digests
                    and workflow_group.workflow_entries
                )
                uploaded = fingerprints(
                    {
                        **workflow_group.workflow_group_digests,
                        **{
                            path: digest
                            for digests in workflow_group.workflow_digests.values()
                            for path, digest in digests.items()
                        },
                    }
                )
                uploaded["auth"] = workflow_group.auth
            progress = target.running_deploy(workflow_group.deploy)
            # A stop goes ahead; anything else waits for the deploy to finish starting.
            if not (ready and progress and progress.phase == "starting"):
                break
            # Checked each second, so a DELETE that comes meanwhile stops it right away.
            with progress.changed:
                progress.changed.wait_for(lambda: progress.phase != "starting", 1)
        with workflow_group.lock:
            progress = target.running_deploy(workflow_group.deploy)
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
            workflow_group.applying = None if action == "none" else action
            failure = None
            if action in ("stop", "restart"):
                failure = target.stop(progress)
            if action == "start" or (action == "restart" and not failure):
                workflow_group.deploy = target.start(
                    workflow_group.workspace,
                    workflow_group.name,
                    uploaded,
                    workflow_group.lock,
                )
            elif action == "reload":
                failure = target.reload(progress, uploaded["config"])
        with _changes:
            workflow_group.applying = None
            workflow_group.applied_generation = generation
            workflow_group.last_apply = {
                "generation": generation,
                "action": action,
                "ok": not failure,
                "error": None,
                "code": None,
                **(failure or {}),
            }
            _changes.notify_all()


def _add_workflow_group(workflow_group_id, workspace):
    """Hold workflow group `workflow_group_id`, uploaded to `workspace`, and start its
    apply loop. Returns it."""
    workflow_group = _workflow_groups[workflow_group_id] = _WorkflowGroup(workspace)
    threading.Thread(target=_apply_changes, args=(workflow_group,), daemon=True).start()
    return workflow_group


if not KUBERNETES:
    _add_workflow_group(os.environ["CANYONOS_WORKFLOW_GROUP_ID"], WORKSPACE_DIR)


@app.get(
    "/v1/workflow-groups",
    summary="List the workflow groups",
    responses={200: WorkflowGroups},
)
def list_workflow_groups():
    """Return the one workflow group this server holds, with the name its last `PUT`
    gave it."""
    with _changes:
        workflow_groups = [
            {"workflow_group_id": workflow_group_id, "name": workflow_group.name}
            for workflow_group_id, workflow_group in _workflow_groups.items()
        ]
    return jsonify({"workflow_groups": workflow_groups}), 200


@app.put(
    "/v1/workflow-groups/<workflow_group_id>",
    summary="Upload workflow_group.yaml and its .env",
    responses={200: Uploaded, 400: Error},
)
def put_workflow_group(path: WorkflowGroupPath, body: WorkflowGroupBody):
    """Write `workflow_group.yaml` and the `.env` beside it into `/workspace`, removing
    that `.env` when `env` is null, and keep `name` as the workflow group's name. With
    `workflows`, remove the uploaded workflows it leaves out; with `api_key_hash`, keep
    it as the workflow group's API key, none when it is empty."""
    with _changes:
        workflow_group = _workflow_groups.get(path.workflow_group_id)
        # Only on Kubernetes, where its first `PUT` adds a workflow group.
        if workflow_group is None:
            workspace = os.path.join(WORKSPACE_DIR, path.workflow_group_id)
            os.makedirs(workspace, exist_ok=True)
            workflow_group = _add_workflow_group(path.workflow_group_id, workspace)
        for file, text in {DEPLOYMENT_CONFIG: body.config, ".env": body.env}.items():
            full_path = os.path.join(workflow_group.workspace, file)
            if text is not None:
                with open(full_path, "w", encoding="utf-8") as f:
                    f.write(text)
                workflow_group.workflow_group_digests[file] = hashlib.sha256(
                    text.encode()
                ).hexdigest()
            elif workflow_group.workflow_group_digests.pop(file, None):
                os.remove(full_path)
        if body.workflows is not None:
            for name in set(workflow_group.workflow_entries) - set(body.workflows):
                _remove_workflow(workflow_group, name)
        if body.api_key_hash is not None:
            workflow_group.auth = (
                {"apiKeyHash": body.api_key_hash} if body.api_key_hash else {}
            )
        workflow_group.name = body.name
        generation = _record_change(workflow_group)
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
    "/v1/workflow-groups/<workflow_group_id>",
    summary="Stop the deploy and remove the upload",
    responses={200: Generation, 500: Error, 504: Error},
)
def delete_workflow_group(path: WorkflowGroupPath):
    """Remove everything uploaded to `/workspace`, then wait for the apply loop to stop
    the deploy; 504 if it did not stop in time, 500 if stopping it failed."""
    workflow_group = _workflow_groups[path.workflow_group_id]
    with _changes:
        workflow_group.name = ""
        for name, entries in workflow_group.workflow_entries.items():
            remove_stale_entries(
                os.path.join(workflow_group.workspace, name), entries, {}
            )
        for file in workflow_group.workflow_group_digests:
            os.remove(os.path.join(workflow_group.workspace, file))
        for upload in (
            workflow_group.workflow_entries,
            workflow_group.workflow_digests,
            workflow_group.workflow_group_digests,
        ):
            upload.clear()
        generation = _record_change(workflow_group)
        _changes.wait_for(lambda: workflow_group.applied_generation >= generation)
        last_apply = workflow_group.last_apply
    if not last_apply["ok"]:
        return jsonify({"error": last_apply["error"], "code": last_apply["code"]}), (
            504 if last_apply["code"] == "stop_timeout" else 500
        )
    return jsonify({"generation": generation}), 200


@app.put(
    "/v1/workflow-groups/<workflow_group_id>/workflows/<name>",
    summary="Upload a workflow",
    responses={200: Uploaded, 400: Error},
)
def put_workflow(path: WorkflowPath, raw: WorkflowArchive):
    """Check the uploaded gzip tar of workflow `name` as `canyonos validate` does, then
    unpack it into `/workspace/<name>`, removing what its last upload had and this one
    lacks; on a 400 (bad archive, unsafe path or findings) the old files stay."""
    name, workflow_group = path.name, _workflow_groups[path.workflow_group_id]
    with tempfile.TemporaryFile() as body, tempfile.TemporaryDirectory() as checked:
        shutil.copyfileobj(raw.stream, body)
        body.seek(0)
        try:
            # nosemgrep: trailofbits.python.tarfile-extractall-traversal.tarfile-extractall-traversal
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
                    workflow_dir = os.path.join(workflow_group.workspace, name)
                    remove_stale_entries(
                        workflow_dir,
                        workflow_group.workflow_entries.get(name, {}),
                        entries,
                    )
                    archive.extractall(workflow_dir, members, filter="tar")
                    with _changes:
                        workflow_group.workflow_entries[name] = entries
                        workflow_group.workflow_digests[name] = {
                            f"{name}/{relative}": digest
                            for relative, digest in digests.items()
                        }
                        generation = _record_change(workflow_group)
        except (tarfile.TarError, EOFError, OSError, ValueError) as e:
            return jsonify(
                {
                    "error": f"Could not unpack the workflow: {e}",
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
                "code": "workflow_invalid",
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
    "/v1/workflow-groups/<workflow_group_id>/workflows/<name>",
    summary="Remove a workflow",
    responses={200: Generation, 400: Error, 404: Error},
)
def delete_workflow(path: WorkflowPath):
    """Remove from `/workspace` what workflow `name`'s last upload put there; 404 if it
    was never uploaded."""
    workflow_group = _workflow_groups[path.workflow_group_id]
    with _changes:
        if path.name not in workflow_group.workflow_entries:
            return jsonify(
                {
                    "error": f"No workflow is named {path.name}",
                    "code": "unknown_workflow",
                }
            ), 404
        _remove_workflow(workflow_group, path.name)
        generation = _record_change(workflow_group)
    return jsonify({"generation": generation}), 200


def _remove_workflow(workflow_group, name):
    """Remove from `workflow_group`'s folder what workflow `name`'s last upload put
    there, and forget that upload; call it holding `_changes`."""
    remove_stale_entries(
        os.path.join(workflow_group.workspace, name),
        workflow_group.workflow_entries.pop(name),
        {},
    )
    del workflow_group.workflow_digests[name]


@app.get(
    "/v1/workflow-groups/<workflow_group_id>",
    summary="Read the workflow group's status",
    responses={200: Status},
)
def status(path: WorkflowGroupPath):
    """Report the workflow group's name and `workflow_group.yaml` as last uploaded, how
    far the apply loop got, the deploy's phase, progress and verdict, and while it runs,
    its endpoint, agents and machine errors read from Redis; a part that could not be
    read is left null and named under `errors`."""
    workflow_group = _workflow_groups[path.workflow_group_id]
    try:
        with open(
            os.path.join(workflow_group.workspace, DEPLOYMENT_CONFIG), encoding="utf-8"
        ) as f:
            config = f.read()
    except FileNotFoundError:
        config = None
    report = {
        "version": VERSION,
        "name": workflow_group.name,
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
        "generation": workflow_group.generation,
        "applied_generation": workflow_group.applied_generation,
        "applying": workflow_group.applying,
        "last_apply": workflow_group.last_apply,
        "errors": [],
    }
    target.status(workflow_group.deploy, report)
    return jsonify(report), 200


@app.get(
    "/v1/workflow-groups/<workflow_group_id>/logs/controller",
    summary="Read the controller log",
    responses={200: TEXT, 400: Error},
)
def controller_log(path: WorkflowGroupPath, query: LogsQuery):
    """Return the deploy process's kept output, the last `tail` lines of it, as text;
    with `follow=true`, keep streaming new lines until the process has exited and every
    line was sent. Empty when nothing was deployed yet."""
    tail, progress = query.tail, _workflow_groups[path.workflow_group_id].deploy
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
    sent. Streams
    `GET /v1/workflow-groups/<workflow_group_id>/logs/controller?follow=true`."""
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
    "/v1/workflow-groups/<workflow_group_id>/health",
    summary="Check the running deploy",
    responses={200: Health, 409: Error},
)
def health(path: WorkflowGroupPath):
    """Check the running deploy's Global Controller, Redis, each agent's replica count
    and its endpoint, each with how to fix it when it fails; 409 if no deploy is
    running."""
    return target.health(_workflow_groups[path.workflow_group_id].deploy)


def _workflow(workflow_group, name):
    """`workflow_group`'s uploaded workflow `name` as the workflows routes answer it:
    its name, the fingerprints of its files and the query in its
    `config/test_query.txt`."""
    path = os.path.join(workflow_group.workspace, name, "config", "test_query.txt")
    try:
        with open(path, encoding="utf-8") as f:
            test_query = f.read().strip() or None
    except OSError:
        test_query = None
    return {
        "name": name,
        "fingerprints": fingerprints(workflow_group.workflow_digests[name]),
        "test_query": test_query,
    }


@app.get(
    "/v1/workflow-groups/<workflow_group_id>/workflows",
    summary="List the uploaded workflows",
    responses={200: Workflows},
)
def list_workflows(path: WorkflowGroupPath):
    """Return every uploaded workflow, by name."""
    workflow_group = _workflow_groups[path.workflow_group_id]
    with _changes:
        workflows = [
            _workflow(workflow_group, name)
            for name in sorted(workflow_group.workflow_digests)
        ]
    return jsonify({"workflows": workflows}), 200


@app.get(
    "/v1/workflow-groups/<workflow_group_id>/workflows/<name>",
    summary="Read a workflow",
    responses={200: Workflow, 400: Error, 404: Error},
)
def get_workflow(path: WorkflowPath):
    """Return uploaded workflow `name`; 404 if it was never uploaded."""
    workflow_group = _workflow_groups[path.workflow_group_id]
    with _changes:
        if path.name not in workflow_group.workflow_digests:
            return jsonify(
                {
                    "error": f"No workflow is named {path.name}",
                    "code": "unknown_workflow",
                }
            ), 404
        workflow = _workflow(workflow_group, path.name)
    return jsonify(workflow), 200


@app.get(
    "/v1/workflow-groups/<workflow_group_id>/logs/agents/<name>",
    summary="Read an agent's replica logs",
    responses={200: ReplicaLogs, 400: Error, 404: Error, 409: Error, 503: Error},
)
def logs(path: AgentPath, query: TailQuery):
    """Return the last `tail` lines of each running replica of agent `name`, or of the
    one replica whose ID is `name`, read on its machine; 409 if no deploy is running,
    404 naming the agents when `name` is neither, 503 when Redis cannot be read."""
    return target.agent_logs(
        _workflow_groups[path.workflow_group_id].deploy, path.name, query.tail
    )


@app.put(
    DASHBOARD_ROUTE,
    summary="Register the workflow group's Redis with the dashboard",
    responses={200: DashboardWorkflows, 400: Error, 502: Error},
)
def put_dashboard(path: WorkflowGroupPath, body: DashboardBody):
    """Send this workflow group's Redis host, port and password, plus a client
    certificate its CA signs when its Redis takes only TLS, to the dashboard api at
    `url` and return the workflows it registered. Connection failures and 5xx answers
    are retried for a minute; 502 when the api refuses it or never answers."""
    payload = {
        "redis_host": os.environ["CANYONOS_REDIS_HOST"],
        "redis_port": DEFAULT_REDIS_PORT,
        "redis_password": os.environ[PASSWORD_ENV],
    }
    # Redis takes only TLS clients with a certificate the workflow group's CA signed.
    if internal_ca.available():
        cert, key = internal_ca.sign(["dashboard"])
        payload["redis_tls"] = {
            "ca": base64.b64decode(os.environ[internal_tls.CA_CERT_ENV]).decode(),
            "cert": cert.decode(),
            "key": key.decode(),
        }
    registration = urllib.request.Request(
        f"{body.url}/canyonos/workflows",
        data=json.dumps(payload).encode(),
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
        restore(_add_workflow_group, WORKSPACE_DIR)
    run_simple("0.0.0.0", 8000, app, threaded=True)
