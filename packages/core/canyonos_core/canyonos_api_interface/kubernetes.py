# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The CanyonOS API server's Kubernetes side, run in its own pod for every workflow
group in the cluster: build a workflow group's workflows in the cluster, whose build
applies them, delete it, read its status, agent logs and health from its CanyonBuild,
CanyonProject and CanyonAgents, find the workflow groups again after a restart, and
check who calls the server."""

import io
import json
import os
import tarfile
import threading
import time
import uuid
from functools import partial
from urllib.parse import quote, urlsplit

import requests
import yaml
from flask import jsonify, request

from canyonos_core.controller.utils.config_env import read_dotenv
from canyonos_core.deploy_progress import DeployProgress
from canyonos_core.endpoint import route_path
from canyonos_core.kubernetes.api import (
    API_GROUP,
    API_VERSION,
    MANAGED_BY_LABEL,
    KubernetesApi,
    KubernetesError,
    resource_name,
)
from canyonos_core.kubernetes.manifests import FIELD_MANAGER, LABEL_PROJECT, MANAGED_BY
from canyonos_core.reconciler.parallel import run_in_parallel
from canyonos_core.schema import (
    DEPLOYMENT_CONFIG,
    SchemaError,
    check_deployment,
    workflow_names,
)

STARTUP_TIMEOUT_SECONDS = 30 * 60
# As long as `canyonos stop` used to wait for a project's agents to drain.
STOP_TIMEOUT_SECONDS = 15 * 60
POLL_SECONDS = 2
# Where a build pod takes the project's upload (the operator's builders.UploadPort).
UPLOAD_PORT = 8090
# Reasons the operator gives for a CanyonAgent that will never start as configured.
FATAL_REASONS = ("NameMismatch", "Unsupported", "ProjectNotFound")
LABEL_AGENT = f"{API_GROUP}/agent"
# The fingerprints a workflow group runs, kept on its CanyonProject for after a restart.
DEPLOYED_ANNOTATION = f"{API_GROUP}/deployed"


class _ClusterDeploy(DeployProgress):
    """One deploy of a workflow group's CanyonProject to the cluster, reported as a
    deploy on Docker is; `api` reaches its namespace and `project` is the workflow
    group's name."""

    def __init__(self, api, project, workspace, deployed):
        super().__init__(None, deployed)
        self.api, self.project, self.workspace = api, project, workspace


def running_deploy(progress):
    """Return `progress`, a deploy's progress or None, while its deploy was started and
    not yet stopped, so it may have objects in the cluster, else None."""
    if progress is None or progress.finished:
        return None
    return progress


def start(workspace, name, deployed, lock):
    """Build and apply the workflow group uploaded to `workspace`, named `name`, in the
    cluster on a background thread, recording `deployed` as the fingerprints and auth it
    runs; return its progress. `lock` is held while a failed deploy is stopped."""
    manifest, violations = check_deployment(workspace)
    if violations:
        progress = _ClusterDeploy(None, name, workspace, deployed)
        _fail(progress, "Deploy failed.", "deploy_failed", str(SchemaError(violations)))
        progress.finish(1)
        return progress
    spec = manifest.kubernetes
    api = KubernetesApi.from_environment(
        {**os.environ, "CANYONOS_NAMESPACE": spec.namespace}
    )
    progress = _ClusterDeploy(api, name, workspace, deployed)
    threading.Thread(target=_deploy, args=(progress, spec, lock), daemon=True).start()
    return progress


# The deploys `restore` rebuilt, by workflow_group_id.
_restored = {}


def restore(add_workflow_group, workspace_dir):
    """Hold again, through `add_workflow_group`, each workflow group whose CanyonProject
    is in the cluster, as a running deploy that stop, status and logs reach, its folder
    under `workspace_dir`. Run at startup: the server keeps workflow groups only in
    memory."""
    projects = KubernetesApi.from_environment().request(
        "GET", f"/apis/{API_GROUP}/{API_VERSION}/canyonprojects"
    )["items"]
    for project in projects:
        spec = project["spec"]
        workflow_group_id, name = spec["projectID"], spec["displayName"]
        workspace = os.path.join(workspace_dir, workflow_group_id)
        os.makedirs(workspace, exist_ok=True)
        api = KubernetesApi.from_environment(
            {**os.environ, "CANYONOS_NAMESPACE": project["metadata"]["namespace"]}
        )
        # None for a project deployed before they were kept: its next deploy restarts it.
        deployed = project["metadata"].get("annotations", {}).get(DEPLOYED_ANNOTATION)
        progress = _ClusterDeploy(
            api,
            name,
            workspace,
            json.loads(deployed)
            if deployed
            else {"code": None, "config": None, "auth": None},
        )
        progress.phase = "up"
        workflow_group = add_workflow_group(workflow_group_id, workspace)
        workflow_group.name = name
        # So a sync, which sends no API key, keeps the key the project runs with.
        workflow_group.auth = spec.get("auth", {})
        workflow_group.deploy = _restored[workflow_group_id] = progress


def _deploy(progress, spec, lock):
    """Build the project in the cluster, then wait for its agents, settling `progress`
    as a Docker deploy's output does, and stop it, holding `lock`, once it failed. Runs
    on its own thread, started with the deploy."""
    deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
    try:
        progress.message = "Building images in the cluster..."
        failure = _build(progress, spec, deadline)
        if failure:
            _fail(progress, "Deploy failed.", "deploy_failed", failure)
        else:
            with progress.changed:
                progress.steps.append("Build complete")
                progress.message = "Starting agents..."
        while progress.phase == "starting" and _wait(progress, deadline):
            project, agents = _project_objects(progress)
            fatal = [
                f"{agent['spec']['agentName']}: {ready.get('message')}"
                for agent in agents
                if (ready := agent["conditions"].get("Ready", {})).get("reason")
                in FATAL_REASONS
            ]
            if fatal:
                _fail(progress, "Deploy failed.", "deploy_failed", "\n".join(fatal))
            elif (
                project
                and agents
                and all(
                    obj["conditions"].get("Ready", {}).get("status") == "True"
                    for obj in [project, *agents]
                )
            ):
                _record_deployed(progress, project)
                with progress.changed:
                    progress.phase, progress.message = "up", None
                    progress.steps.append(f"{len(agents)} agent(s) ready")
                    progress.changed.notify_all()
    except TimeoutError:
        _fail(
            progress,
            f"The deploy was not up within {STARTUP_TIMEOUT_SECONDS // 60} minutes.",
            "deploy_timeout",
        )
    except Exception as e:
        _fail(progress, "Deploy failed.", "deploy_failed", str(e))
    with lock:
        if progress.phase == "failed" and running_deploy(progress):
            stop(progress)


def _fail(progress, error, code, root_cause=None):
    """Mark the deploy failed with `error`, its `code` and `root_cause`, unless it is
    being stopped."""
    with progress.changed:
        if not progress.stopping:
            progress.phase, progress.error = "failed", error
            progress.error_code, progress.root_cause = code, root_cause
            progress.changed.notify_all()


def _wait(progress, deadline):
    """Wait a poll interval, cut short when the deploy starts stopping; return whether
    it is not being stopped. Raises TimeoutError past `deadline`."""
    with progress.changed:
        progress.changed.wait_for(lambda: progress.stopping, POLL_SECONDS)
    if time.monotonic() > deadline:
        raise TimeoutError
    return not progress.stopping


def _build(progress, spec, deadline):
    """Build the deploy's workflows as its `kubernetes:` settings `spec` say: the
    workflow group's `.env` and each workflow's into Secrets, then a CanyonBuild whose
    pod takes the upload, builds and pushes the images and applies the workflow group.
    Returns why it failed, or None once it succeeded."""
    api, project = progress.api, resource_name(progress.project)
    labels = {LABEL_PROJECT: project, MANAGED_BY_LABEL: MANAGED_BY}
    env = read_dotenv(os.path.join(progress.workspace, ".env"))
    env_secret = spec.env_secret or (f"{project}-env" if env else None)
    if not spec.env_secret:
        # Each workflow's agents get its own .env, by the name manifests.py gives it.
        secrets = {
            f"{project}-{resource_name(name)}-env": read_dotenv(
                os.path.join(progress.workspace, name, ".env")
            )
            for name in workflow_names(progress.workspace)
        }
        if env:
            secrets[f"{project}-env"] = env
        for secret, values in secrets.items():
            api.apply(
                {
                    "apiVersion": "v1",
                    "kind": "Secret",
                    "type": "Opaque",
                    "metadata": {
                        "name": secret,
                        "namespace": api.namespace,
                        "labels": labels,
                    },
                    "stringData": values,
                },
                FIELD_MANAGER,
            )
    tag = time.strftime("%Y%m%d-%H%M%S")
    # Random too: two builds in the same second would otherwise share a name.
    suffix = f"-{tag}-{uuid.uuid4().hex[:4]}"
    name = project[: 63 - len(suffix)].rstrip("-") + suffix
    build = {
        "project": progress.project,
        "config": DEPLOYMENT_CONFIG,
        "registry": spec.registry,
        "tag": tag,
        "platform": spec.platform,
        "envSecretRef": env_secret,
        "registrySecretRef": spec.image_pull_secret,
        "imagePullSecrets": spec.image_pull_secret
        and [{"name": spec.image_pull_secret}],
        "auth": progress.deployed["auth"],
    }
    api.apply(
        {
            "apiVersion": f"{API_GROUP}/{API_VERSION}",
            "kind": "CanyonBuild",
            "metadata": {"name": name, "namespace": api.namespace, "labels": labels},
            "spec": {key: value for key, value in build.items() if value},
        },
        FIELD_MANAGER,
    )
    path = (
        f"/apis/{API_GROUP}/{API_VERSION}/namespaces/{api.namespace}"
        f"/canyonbuilds/{name}"
    )
    uploaded = False
    while _wait(progress, deadline):
        status = api.request("GET", path).get("status", {})
        if status.get("phase") == "Failed":
            return status.get("message") or "The image build failed."
        if status.get("phase") == "Succeeded":
            api.request("DELETE", path)
            return None
        if status.get("phase") == "Receiving" and not uploaded:
            try:
                _upload(api, status["podName"], progress.workspace)
                uploaded = True
            except requests.ConnectionError:
                # The pod's receiver isn't listening yet: send it again next poll.
                continue
    return "The deploy was stopped."


def _upload(api, pod, workspace):
    """Send `workspace`, without its `.env` files, as a gzipped tar to the receiver in
    build pod `pod`, at the pod's address."""
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode="w:gz") as tar:
        for entry in os.listdir(workspace):
            # The `.env` values reach the build and the agents as a Secret instead.
            tar.add(
                os.path.join(workspace, entry),
                entry,
                filter=lambda info: (
                    None if os.path.basename(info.name).startswith(".env") else info
                ),
            )
    address = api.request("GET", f"/api/v1/namespaces/{api.namespace}/pods/{pod}")[
        "status"
    ]["podIP"]
    requests.put(
        f"http://{address}:{UPLOAD_PORT}/", data=archive.getvalue(), timeout=300
    ).raise_for_status()


def _project_objects(progress):
    """Read the deploy's CanyonProject, None until its build applied it, and its
    CanyonAgents from the cluster, each with its status conditions by type under
    `conditions`. Used by status, health and the deploy's wait for its agents."""
    api, project = progress.api, resource_name(progress.project)
    projects = api.request(
        "GET",
        f"/apis/{API_GROUP}/{API_VERSION}/namespaces/{api.namespace}/canyonprojects"
        f"?labelSelector={API_GROUP}%2Fproject%3D{project}",
    )["items"]
    agents = api.canyon_agents(project)
    for obj in projects + agents:
        obj["conditions"] = {
            condition["type"]: condition
            for condition in obj.get("status", {}).get("conditions", [])
        }
    return next(iter(projects), None), agents


def stop(progress):
    """Stop the deploy: delete its CanyonBuilds and CanyonProject, from which the
    operator removes the rest, until none is left, then the ConfigMap and Secrets its
    deploys wrote; return the error and its code when the cluster refused or they were
    still there after 15 minutes."""
    with progress.changed:
        progress.stopping = True
        progress.changed.notify_all()
    api, project = progress.api, resource_name(progress.project)
    objects = f"/apis/{API_GROUP}/{API_VERSION}/namespaces/{api.namespace}"
    deadline = time.monotonic() + STOP_TIMEOUT_SECONDS
    try:
        while found := [
            (f"{objects}/{plural}/{obj['metadata']['name']}", obj["metadata"])
            for plural in ("canyonbuilds", "canyonprojects")
            for obj in api.request(
                "GET",
                f"{objects}/{plural}?labelSelector={API_GROUP}%2Fproject%3D{project}",
            )["items"]
        ]:
            if time.monotonic() > deadline:
                return {
                    "error": f"{progress.project} was still in the cluster after "
                    f"{STOP_TIMEOUT_SECONDS // 60} minutes",
                    "code": "stop_timeout",
                }
            for path, metadata in found:
                if "deletionTimestamp" not in metadata:
                    api.request("DELETE", path)
            time.sleep(POLL_SECONDS)
        written = quote(f"{LABEL_PROJECT}={project},{MANAGED_BY_LABEL}={MANAGED_BY}")
        for kind in ("configmaps", "secrets"):
            api.request(
                "DELETE",
                f"/api/v1/namespaces/{api.namespace}/{kind}?labelSelector={written}",
            )
    except KubernetesError as e:
        return {"error": str(e), "code": "stop_failed"}
    progress.finish(0)
    return None


def reload(progress, config_fingerprint):
    """Rebuild the running deploy's project from the config uploaded to its folder,
    which updates the config its Global Controller reloads, and wait for the build;
    return the error and its code when the config is invalid or the build failed."""
    manifest, violations = check_deployment(progress.workspace)
    if violations:
        return {"error": str(SchemaError(violations)), "code": "config_invalid"}
    try:
        failure = _build(
            progress,
            manifest.kubernetes,
            time.monotonic() + STARTUP_TIMEOUT_SECONDS,
        )
    except TimeoutError:
        return {
            "error": "The build was not done within "
            f"{STARTUP_TIMEOUT_SECONDS // 60} minutes.",
            "code": "reload_timeout",
        }
    except Exception as e:
        failure = str(e)
    if failure:
        return {"error": failure, "code": "reload_failed"}
    progress.deployed = {**progress.deployed, "config": config_fingerprint}
    _record_deployed(progress, _project_objects(progress)[0])
    return None


def _record_deployed(progress, project):
    """Keep the fingerprints `progress` runs on its CanyonProject `project`, where
    `restore` reads them after the server restarts."""
    api = progress.api
    api.request(
        "PATCH",
        f"/apis/{API_GROUP}/{API_VERSION}/namespaces/{api.namespace}/canyonprojects/"
        + project["metadata"]["name"],
        {
            "metadata": {
                "annotations": {DEPLOYED_ANNOTATION: json.dumps(progress.deployed)}
            }
        },
        content_type="application/merge-patch+json",
    )


def status(progress, report):
    """Fill `report` with the phase, progress and verdict of the deploy `progress`
    reports, if any, and while it runs, its endpoint and agents as the cluster reports
    them; a part that could not be read is named under `errors`."""
    if progress is not None:
        report.update(progress.report())
    if not report["running"]:
        return
    try:
        project, agents = _project_objects(progress)
    except KubernetesError as e:
        report["errors"].append(f"Could not read the deploy in the cluster: {e}")
        return
    url = project and project.get("status", {}).get("endpointURL")
    if url:
        parts = urlsplit(url)
        routes = project["spec"]["endpoint"]["routes"]
        for route in routes:
            # The CRD keeps no workflow_id.
            route["workflow_id"] = None
        report["endpoint"] = {
            "public_host": parts.hostname,
            "api_port": parts.port or (443 if parts.scheme == "https" else 80),
            "routes": [
                {**route, "url": url.rstrip("/") + route_path(route)}
                for route in routes
            ],
        }
    report["agents"] = {}
    for agent in agents:
        ready = agent["conditions"].get("Ready", {})
        report["agents"][agent["spec"]["agentName"]] = {
            "desired_replicas": agent["spec"]["replicas"],
            "running_replicas": agent.get("status", {}).get("readyReplicas", 0),
            "launch_error": ready.get("message")
            if ready.get("reason") in (*FATAL_REASONS, "Unschedulable")
            else None,
        }


def health(progress):
    """Answer `GET .../health` from the cluster: whether the running deploy's Global
    Controller, Redis, agents and endpoint are ready, as its CanyonProject and
    CanyonAgents report, each with how to fix it when not; 409 if no deploy runs."""
    if not running_deploy(progress):
        return jsonify({"error": "not running", "code": "not_running"}), 409
    project, agents = _project_objects(progress)
    conditions = project["conditions"] if project else {}
    describe = (
        f"see `kubectl -n {progress.api.namespace} describe canyonproject "
        f"{resource_name(progress.project)}`"
    )
    short = [
        f"{agent['spec']['agentName']}: {ready} of {agent['spec']['replicas']} "
        "replicas ready"
        for agent in agents
        if (ready := agent.get("status", {}).get("readyReplicas", 0))
        < agent["spec"]["replicas"]
    ]
    found = [
        (
            name,
            conditions.get(kind, {}).get("status") == "True",
            conditions.get(kind, {}).get("message") or "not reported yet",
            describe,
        )
        for name, kind in (
            ("Global Controller", "ControllerReady"),
            ("Redis", "RedisReady"),
            ("Endpoint", "EndpointReady"),
        )
    ]
    found.insert(
        2,
        (
            "Workflow agents",
            not short,
            "; ".join(short) or f"{len(agents)} agent(s) running",
            "run `canyonos logs <agent>` to see why, or `canyonos status` for its "
            "launch error",
        ),
    )
    checks = [
        {"name": name, "ok": ok, "detail": detail, "fix": None if ok else fix}
        for name, ok, detail, fix in found
    ]
    return jsonify({"ok": all(check["ok"] for check in checks), "checks": checks}), 200


def agent_logs(progress, name, tail):
    """Answer `GET .../logs/agents/<name>` from the cluster: the last `tail` lines of
    each replica's pod of agent `name`, or of the pod named `name`; 409 if no deploy
    runs, 404 naming the agents when `name` is neither, 503 when it can't be read."""
    if not running_deploy(progress):
        return jsonify({"error": "not running", "code": "not_running"}), 409
    api = progress.api
    try:
        agents = api.canyon_agents(resource_name(progress.project))
        objects = {
            agent["metadata"]["name"]
            for agent in agents
            if agent["spec"]["agentName"] == name
        }
        pods = [
            pod["metadata"]["name"]
            for pod in api.project_pods()
            # One replica: its pod has its name, as Kubernetes writes it.
            if resource_name(name) == pod["metadata"]["name"]
            or pod["metadata"]["labels"].get(LABEL_AGENT) in objects
        ]
    except KubernetesError as e:
        return jsonify(
            {
                "error": f"Could not read the replicas: {e}",
                "code": "replicas_unreadable",
            }
        ), 503
    if not pods and not objects:
        names = ", ".join(agent["spec"]["agentName"] for agent in agents)
        return jsonify(
            {
                "error": f"No agent or replica is named {name}; the agents are {names}",
                "code": "unknown_agent",
            }
        ), 404
    lines = "" if tail == "all" else f"?tailLines={tail}"
    jobs = {
        pod: partial(
            api.request,
            "GET",
            f"/api/v1/namespaces/{api.namespace}/pods/{pod}/log{lines}",
            text=True,
        )
        for pod in pods
    }
    logs = {
        pod: [f"Could not read the log: {error}"] if error else text.splitlines()
        for pod, text, error in run_in_parallel(jobs)
    }
    return jsonify({"logs": logs}), 200


def check_caller(authorization, configs, verb):
    """Answer 401 unless `authorization`, a request's Authorization header, holds the
    Bearer token of a user the cluster knows, and 403 unless that user may `verb`
    CanyonProjects in the namespace each `workflow_group.yaml` text in `configs` names,
    and in that of the request's workflow group while its deploy `restore` rebuilt
    runs."""
    if not authorization.startswith("Bearer "):
        return jsonify(
            {
                "error": "Send your Kubernetes login: `Authorization: Bearer <token>`.",
                "code": "unauthenticated",
            }
        ), 401
    api = KubernetesApi.from_environment()
    review = api.request(
        "POST",
        "/apis/authentication.k8s.io/v1/tokenreviews",
        {
            "apiVersion": "authentication.k8s.io/v1",
            "kind": "TokenReview",
            "spec": {"token": authorization.removeprefix("Bearer ")},
        },
    )["status"]
    if not review.get("authenticated"):
        return jsonify(
            {
                "error": "The cluster does not accept this token: sign in again.",
                "code": "unauthenticated",
            }
        ), 401
    user = review["user"]
    namespaces = []
    for config in configs:
        try:
            namespaces.append(yaml.safe_load(config)["kubernetes"]["namespace"])
        except (yaml.YAMLError, TypeError, KeyError):
            # None asks whether the user may do it in every namespace.
            namespaces.append(None)
    # A rebuilt deploy has no uploaded workflow_group.yaml naming its namespace.
    restored = running_deploy(
        _restored.get((request.view_args or {}).get("workflow_group_id"))
    )
    if restored:
        namespaces.append(restored.api.namespace)
    for namespace in namespaces:
        access = api.request(
            "POST",
            "/apis/authorization.k8s.io/v1/subjectaccessreviews",
            {
                "apiVersion": "authorization.k8s.io/v1",
                "kind": "SubjectAccessReview",
                "spec": {
                    "user": user.get("username"),
                    "uid": user.get("uid"),
                    "groups": user.get("groups"),
                    "extra": user.get("extra"),
                    "resourceAttributes": {
                        "namespace": namespace,
                        "verb": verb,
                        "group": API_GROUP,
                        "resource": "canyonprojects",
                    },
                },
            },
        )["status"]
        if not access.get("allowed"):
            return jsonify(
                {
                    "error": f"{user.get('username')} may not {verb} CanyonProjects "
                    f"in namespace {namespace}.",
                    "code": "forbidden",
                }
            ), 403
    return None
