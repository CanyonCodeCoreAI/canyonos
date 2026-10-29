# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos deploy --target kubernetes`, and the Kubernetes versions of `status`,
`logs`, `stop`, `clean` and `serve`.

The CLI hands the project to the cluster: its `.env` as a Secret, then a CanyonBuild
the CanyonOS operator (installed once per cluster) runs as a build pod. The project is
uploaded to that pod, which builds the images on the cluster's builder, pushes them to
the `kubernetes:` block's registry and applies the project from its config. Cluster
access goes through `kubectl`, so every way of signing in to a cluster (EKS,
OpenShift, a kubeconfig) works, and a namespace's edit role is all it needs.
"""

import io
import json
import os
import re
import subprocess
import tarfile
import time
import urllib.error
import urllib.request
import uuid

import yaml
from dotenv import dotenv_values
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from canyonos import env, ui
from canyonos.constants import (
    existing_config_path,
    project_env_path,
    project_root,
)
from canyonos.deploy import save_project_id
from canyonos.project import project_name

GROUP = "canyonos.canyoncode.ai"
API_VERSION = f"{GROUP}/v1alpha1"
LABEL_PROJECT = f"{GROUP}/project"
LABEL_AGENT = f"{GROUP}/agent"
LABEL_MANAGED_BY = "app.kubernetes.io/managed-by"
MANAGED_BY = "canyonos-cli"
FIELD_MANAGER = "canyonos-cli"
READY_TIMEOUT_SECONDS = 600
BUILD_TIMEOUT_SECONDS = 3600
BUILD_START_TIMEOUT_SECONDS = 600
# Never uploaded to a build: history and local environments. Any `.env*` file is left
# out too (_uploaded): the `.env` becomes a Secret, and no other one belongs in the cluster.
UPLOAD_EXCLUDES = (".git", ".venv", "node_modules", "__pycache__")
# Where a build pod takes the upload (builders.UploadPort in the operator).
UPLOAD_PORT = 8090
OPERATOR_HINT = (
    "Install the CanyonOS operator once per cluster (helm install canyonos-operator "
    "packages/operator/charts/canyonos-operator); see docs/guides/KUBERNETES.md"
)
# Reasons the operator gives for a CanyonAgent that will never start as configured.
FATAL_REASONS = ("NameMismatch", "Unsupported", "ProjectNotFound")
DASHBOARD_NAMESPACE = "canyonos-dashboard"
DASHBOARD_SERVICE = "svc/canyonos-dashboard-web"
# The project's Global Controller (builders.GCName in the operator).
GLOBAL_CONTROLLER = "deployment/canyonos-gc"


def resource_name(name):
    """The Kubernetes name for an agent or project: lowercase, anything but letters,
    digits and hyphens turned into hyphens (`Portfolio_Agent` becomes `portfolio-agent`).
    Keep in sync with canyonos_core/kubernetes/api.py and the operator's
    builders.ResourceName: the CLI and the core image ship separately."""
    object_name = re.sub(r"[^a-z0-9-]+", "-", name.lower()).strip("-")
    if not object_name:
        raise RuntimeError(
            f"{name!r} has no letters or digits to name a Kubernetes object"
        )
    return object_name[:63].rstrip("-")


# --------------------------------------------------------------------------------
# Reading the project
# --------------------------------------------------------------------------------


def resolve_config(config_path):
    """The config file to read: the given one, or the project's own, as on Docker."""
    if not config_path:
        return existing_config_path()
    if not os.path.isfile(config_path):
        raise RuntimeError(f"Config file not found: {config_path}")
    return config_path


def read_dotenv(path=None):
    """The project's `.env` as a dict (empty when there is none): the one in the folder
    `canyonos` runs in, as on Docker."""
    path = path or project_env_path()
    if not os.path.isfile(path):
        return {}
    return {k: v for k, v in dotenv_values(path).items() if v is not None}


_ENV_REF = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


def _expand(value, values):
    if isinstance(value, dict):
        return {k: _expand(v, values) for k, v in value.items()}
    if not isinstance(value, str):
        return value
    return _ENV_REF.sub(lambda m: values.get(m.group(1), m.group(0)), value)


def load_config(config_path, env_values=None):
    """`global_controller.yaml` as a dict, `${VAR}` filled in inside the `kubernetes:`
    block from `.env` alone: the values the build in the cluster sees too. Fails with
    a fix when the block is missing; the build checks the rest."""
    with open(config_path, encoding="utf-8") as f:
        config = yaml.safe_load(f) or {}
    if not isinstance(config, dict):
        raise RuntimeError(f"{config_path} must contain a YAML mapping")
    block = config.get("kubernetes")
    if (
        not isinstance(block, dict)
        or not block.get("namespace")
        or not block.get("registry")
    ):
        raise RuntimeError(
            f"{config_path} needs a `kubernetes:` block with `namespace` and `registry` "
            "to deploy to Kubernetes (see docs/guides/KUBERNETES.md#configuration)"
        )
    config["kubernetes"] = _expand(block, env_values or {})
    return config


def namespace_object(namespace):
    """The project's namespace, when `canyonos deploy` creates it."""
    return {
        "apiVersion": "v1",
        "kind": "Namespace",
        "metadata": {"name": namespace, "labels": {LABEL_MANAGED_BY: MANAGED_BY}},
    }


def dotenv_secret(namespace, name, project, values):
    """The Secret holding the app's API keys from `.env`. Applied to the cluster, never
    written to a file."""
    return {
        "apiVersion": "v1",
        "kind": "Secret",
        "type": "Opaque",
        "metadata": {
            "name": name,
            "namespace": namespace,
            "labels": {LABEL_PROJECT: project, LABEL_MANAGED_BY: MANAGED_BY},
        },
        "stringData": {k: str(v) for k, v in values.items()},
    }


# --------------------------------------------------------------------------------
# The canyonos-core image a build runs
# --------------------------------------------------------------------------------


def _has_registry(reference):
    first = reference.split("/", 1)[0]
    return "/" in reference and ("." in first or ":" in first or first == "localhost")


def _docker(argv, timeout=600):
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        raise RuntimeError("Docker is not installed or not on PATH") from None


def _push_local_image(image, registry, tag):
    """Push an image that only exists in the local Docker daemon (a development
    canyonos-core) to the registry and return it pinned by digest."""
    repository = f"{registry.rstrip('/')}/{image.split('/')[-1].split(':')[0]}"
    remote = f"{repository}:{tag}"
    for argv in (["docker", "tag", image, remote], ["docker", "push", remote]):
        result = _docker(argv)
        if result.returncode:
            raise RuntimeError(f"`{' '.join(argv)}` failed: {result.stderr.strip()}")
    inspected = _docker(
        ["docker", "inspect", "--format", "{{json .RepoDigests}}", remote]
    )
    digests = json.loads(inspected.stdout.strip() or "[]") or []
    pinned = next((d for d in digests if d.startswith(repository + "@")), None)
    if not pinned:
        raise RuntimeError(f"Pushed {remote} but Docker reports no digest for it")
    return pinned


def build_image(registry, tag):
    """The canyonos-core image the build runs, or "" for the one the cluster's
    operator was installed with (its own, possibly mirrored, release image). Only a
    development override is named: as is when it is in a registry, otherwise pushed
    to the project's registry first."""
    image = env.core_image
    if image == env.PROD_CORE_IMAGE:
        return ""
    if _has_registry(image):
        return image
    return _push_local_image(image, registry, tag)


# --------------------------------------------------------------------------------
# Building in the cluster, which then applies the project
# --------------------------------------------------------------------------------


def _uploaded(name):
    return name not in UPLOAD_EXCLUDES and not name.startswith(".env")


def source_tarball(project_dir=None):
    """The project root as the build reads it, gzipped (`.canyon` when the project was
    converted, else this folder, as Docker syncs it): everything but UPLOAD_EXCLUDES
    and `.env*`, so no API key leaves for the cluster inside it."""
    project_dir = project_dir or project_root()
    buffer = io.BytesIO()

    def keep(info):
        if not all(_uploaded(part) for part in info.name.split("/")):
            return None
        info.uid = info.gid = 0
        info.uname = info.gname = ""
        return info

    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for entry in sorted(os.listdir(project_dir)):
            if _uploaded(entry):
                tar.add(os.path.join(project_dir, entry), arcname=entry, filter=keep)
    return buffer.getvalue()


def canyon_build(name, namespace, project, config_rel, k8s, tag, image, env_secret):
    """The CanyonBuild asking the operator to build the project in the cluster and
    apply it from its config."""
    spec = {
        "project": project,
        "config": config_rel,
        "registry": k8s["registry"],
        "tag": tag,
    }
    if image:
        spec["image"] = image
    if env_secret:
        spec["envSecretRef"] = env_secret
    if k8s.get("platform"):
        # Left out, the cluster builds for its own nodes' architecture.
        spec["platform"] = k8s["platform"]
    if k8s.get("image_pull_secret"):
        # The registry's credentials: to push the images, and to pull the build's own.
        spec["registrySecretRef"] = k8s["image_pull_secret"]
        spec["imagePullSecrets"] = [{"name": k8s["image_pull_secret"]}]
    return {
        "apiVersion": API_VERSION,
        "kind": "CanyonBuild",
        "metadata": {
            "name": name,
            "namespace": namespace,
            "labels": {
                LABEL_PROJECT: resource_name(project),
                LABEL_MANAGED_BY: MANAGED_BY,
            },
        },
        "spec": spec,
    }


def wait_for_build(
    namespace, name, phases, timeout, sleep=time.sleep, clock=time.monotonic
):
    """Wait until the CanyonBuild reaches one of `phases`; fail with the build's own
    error when it fails."""
    deadline = clock() + timeout
    while True:
        status = kubectl_json(["get", "canyonbuild", name, "-n", namespace]).get(
            "status", {}
        )
        if status.get("phase") == "Failed":
            raise RuntimeError(
                f"The image build failed:\n{status.get('message', '').strip()}\n"
                f"Full log: kubectl -n {namespace} logs job/{name} -c build "
                f"(the CanyonBuild {name} is kept for a look)"
            )
        if status.get("phase") in phases:
            return status
        if clock() > deadline:
            raise RuntimeError(
                f"The build {name} did not get past {status.get('phase') or 'Pending'} in "
                f"{timeout // 60} minutes ({status.get('message') or 'no message'}). "
                f"Look at: kubectl -n {namespace} describe pod -l {GROUP}/build={name}"
            )
        sleep(2)


def _port_forward(namespace, pod):
    """A port-forward to the build pod's upload port, and the local URL it serves."""
    forward = subprocess.Popen(
        ["kubectl", "port-forward", "-n", namespace, f"pod/{pod}", f":{UPLOAD_PORT}"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    line = forward.stdout.readline()
    match = re.search(r"127\.0\.0\.1:(\d+)", line)
    if not match:
        forward.terminate()
        raise RuntimeError(f"Could not reach the build pod {pod}: {line.strip()}")
    return forward, f"http://127.0.0.1:{match.group(1)}/"


def upload_project(namespace, pod, archive, attempts=10, sleep=time.sleep):
    """Send the project to the build pod through a port-forward (no exec rights
    needed); the pod starts building once it is in."""
    forward, url = _port_forward(namespace, pod)
    try:
        # Straight to the port-forward: never through a proxy from HTTP_PROXY or the
        # Windows or macOS system settings.
        direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for attempt in range(attempts):
            # kubectl ends a port-forward that loses its connection to the pod (a busy
            # laptop, a blip of the API server); retrying it would only be refused.
            if forward.poll() is not None:
                forward, url = _port_forward(namespace, pod)
            try:
                request = urllib.request.Request(url, data=archive, method="PUT")
                with direct.open(request, timeout=300):
                    return
            except urllib.error.HTTPError as error:
                # The build pod answered and refused the upload: retrying cannot help.
                detail = error.read().decode("utf-8", "replace").strip()
                raise RuntimeError(
                    f"The build pod {pod} refused the upload ({error.code}): {detail}"
                ) from None
            except (urllib.error.URLError, ConnectionError) as error:
                if attempt == attempts - 1:
                    raise RuntimeError(
                        f"Uploading the project to {pod} failed: {error}"
                    ) from None
                sleep(1)
    finally:
        forward.terminate()


def build_in_cluster(config_path, namespace, project, k8s, env_secret):
    """Build the project's images in the cluster and apply it there: create a
    CanyonBuild, upload the project to its pod, wait until it succeeds. Returns
    {agent: image by digest}."""
    tag = time.strftime("%Y%m%d-%H%M%S")
    # Random too: two deploys in the same second would otherwise share one build.
    suffix = f"-{tag}-{uuid.uuid4().hex[:4]}"
    name = resource_name(project)[: 63 - len(suffix)].rstrip("-") + suffix
    image = build_image(k8s["registry"], tag)
    # The build runs in the uploaded project root, so the config is named from there.
    config_rel = os.path.relpath(config_path, project_root()).replace(os.sep, "/")
    apply(
        [
            canyon_build(
                name, namespace, project, config_rel, k8s, tag, image, env_secret
            )
        ]
    )
    with ui.status("Starting the build in the cluster..."):
        status = wait_for_build(
            namespace, name, ("Receiving",), BUILD_START_TIMEOUT_SECONDS
        )
    with ui.status("Uploading the project to the build..."):
        upload_project(namespace, status["podName"], source_tarball())
    with ui.status("Building images in the cluster..."):
        status = wait_for_build(namespace, name, ("Succeeded",), BUILD_TIMEOUT_SECONDS)
    kubectl(
        ["delete", "canyonbuild", name, "-n", namespace, "--wait=false"], check=False
    )
    return status.get("images") or {}


# --------------------------------------------------------------------------------
# kubectl
# --------------------------------------------------------------------------------


def kubectl(args, *, input_text=None, check=True, timeout=120):
    """Run kubectl with the current context and return the finished process."""
    try:
        result = subprocess.run(
            ["kubectl", *args],
            input=input_text,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except FileNotFoundError:
        raise RuntimeError(
            "kubectl is not installed or not on PATH: https://kubernetes.io/docs/tasks/tools/"
        ) from None
    if check and result.returncode:
        raise RuntimeError(
            f"kubectl {' '.join(args[:3])} failed: {(result.stderr or result.stdout).strip()}"
        )
    return result


def kubectl_json(args):
    """Run a kubectl read and parse its JSON."""
    return json.loads(kubectl([*args, "-o", "json"]).stdout or "{}")


def _forbidden(result):
    return "forbidden" in (result.stderr or "").lower()


def require_operator():
    """Fail with the install step when the cluster has no CanyonOS API. Asked through
    discovery, which every signed-in user may read: reading the CRDs themselves needs
    a cluster-wide permission a namespace's edit role does not have."""
    found = kubectl(["api-resources", f"--api-group={GROUP}", "-o", "name"])
    if f"canyonprojects.{GROUP}" not in found.stdout.split():
        raise RuntimeError(
            f"The CanyonOS operator is not installed on this cluster. {OPERATOR_HINT}"
        )


def ensure_namespace(namespace):
    """Use the namespace, creating it (labelled as the CLI's) when it is missing. One
    you may not even read cluster-wide (forbidden) is taken to exist: a missing one
    then fails at the first object put in it."""
    found = kubectl(["get", "namespace", namespace], check=False)
    if found.returncode == 0 or _forbidden(found):
        return False
    result = kubectl(
        ["create", "-f", "-"],
        input_text=yaml.safe_dump(namespace_object(namespace)),
        check=False,
    )
    if result.returncode:
        raise RuntimeError(
            f"Namespace {namespace} does not exist and could not be created "
            f"({result.stderr.strip()}). Ask a cluster admin for it, or use one you have."
        )
    ui.ok(f"Created namespace {namespace}")
    return True


def apply(objects):
    """Server-side apply, owning only the fields CanyonOS sets."""
    kubectl(
        [
            "apply",
            "--server-side",
            f"--field-manager={FIELD_MANAGER}",
            "--force-conflicts",
            "-f",
            "-",
        ],
        input_text=yaml.safe_dump_all(objects, sort_keys=False),
    )


def project_agents(namespace, project):
    """The project's CanyonAgents in the cluster."""
    return kubectl_json(
        ["get", "canyonagents", "-n", namespace, "-l", f"{LABEL_PROJECT}={project}"]
    ).get("items", [])


def condition(obj, kind):
    """One of an object's status conditions, or {}."""
    for entry in obj.get("status", {}).get("conditions", []) or []:
        if entry.get("type") == kind:
            return entry
    return {}


def wait_until_ready(
    namespace,
    project,
    timeout=READY_TIMEOUT_SECONDS,
    sleep=time.sleep,
    clock=time.monotonic,
):
    """Wait until the project and every agent are Ready; show progress, and fail
    with the operator's reason when an agent will never start as configured."""
    deadline = clock() + timeout
    with ui.status("Starting on Kubernetes...") as spinner:
        while True:
            proj = kubectl_json(["get", "canyonproject", project, "-n", namespace])
            agents = project_agents(namespace, project)
            project_ready = condition(proj, "Ready")
            ready_now = project_ready.get("status") == "True"
            parts = [
                f"project {'ready' if ready_now else project_ready.get('reason') or 'starting'}"
            ]
            if not ready_now:
                # Redis, the global controller or the endpoint with no node to run on.
                for kind in ("RedisReady", "ControllerReady", "EndpointReady"):
                    part = condition(proj, kind)
                    if part.get("reason") == "Unschedulable":
                        parts.append(part.get("message", ""))
            all_ready = ready_now and bool(agents)
            for a in agents:
                status, spec = a.get("status", {}), a.get("spec", {})
                ready = condition(a, "Ready")
                if ready.get("reason") in FATAL_REASONS:
                    raise RuntimeError(
                        f"{spec.get('agentName')}: {ready.get('message')}"
                    )
                part = f"{spec.get('agentName')} {status.get('readyReplicas', 0)}/{spec.get('replicas', '?')}"
                if ready.get("reason") == "Unschedulable":
                    # Not fatal (an autoscaler may add a node), but the reason to see.
                    part += f" ({ready.get('message')})"
                parts.append(part)
                all_ready = all_ready and ready.get("status") == "True"
            summary = " · ".join(parts)
            spinner.update(f"Starting on Kubernetes: {summary}")
            if all_ready:
                return proj, agents
            if clock() > deadline:
                raise RuntimeError(
                    f"Not ready after {timeout // 60} minutes ({summary}). See "
                    f"`kubectl -n {namespace} get pods` and `kubectl -n {namespace} describe canyonagents`."
                )
            sleep(3)


def scaling_conflicts(agents):
    """One line per agent an HPA also scales: it would fight the global controller."""
    return [
        f"{a.get('spec', {}).get('agentName', '')}: {conflict.get('message', '')}"
        for a in agents
        if (conflict := condition(a, "ScalingConflict")).get("status") == "True"
    ]


# --------------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------------


def _env_secret(k8s, project, env_values):
    return k8s.get("env_secret") or (f"{project}-env" if env_values else None)


def _summary(namespace, project_obj, config):
    endpoint = config.get("endpoint") or {}
    method = endpoint.get("method", "")
    url = project_obj.get("status", {}).get("endpointURL", "")
    arguments = []
    for agent_spec in config.get("agents") or []:
        if agent_spec.get("name") == endpoint.get("agent"):
            for function in agent_spec.get("functions") or []:
                if function.get("name") == method:
                    arguments = [a.get("name") for a in function.get("arguments") or []]
    body = json.dumps({name: "your query" for name in arguments})
    lines = [Text.assemble(("Namespace  ", "bold"), namespace)]
    if ".svc:" in url:
        lines.append(
            Text.assemble(("Endpoint   ", "bold"), f"{url} (inside the cluster)")
        )
        lines.append(
            Text.assemble(
                ("From here  ", "bold"),
                f"kubectl -n {namespace} port-forward svc/canyonos-endpoint 8080:8080",
            )
        )
        url = "http://127.0.0.1:8080"
    else:
        lines.append(Text.assemble(("Endpoint   ", "bold"), url))
    lines.append(
        Text.assemble(
            ("Call       ", "bold"),
            f"curl -X POST {url}/{method} -H \"Content-Type: application/json\" -d '{body}'",
        )
    )
    lines.append(
        Text.assemble(("Poll       ", "bold"), f"curl {url}/status/<request_id>")
    )
    lines.append(
        Text.assemble(("Status     ", "bold"), "canyonos status --target kubernetes")
    )
    return Panel(
        Text("\n").join(lines), title="Deployed to Kubernetes", title_align="left"
    )


def run_kubernetes_deploy(config_path=None, timeout=READY_TIMEOUT_SECONDS):
    """Run `canyonos deploy --target kubernetes`: hand the project to the cluster, which
    builds its images and applies its objects from its config; this only uploads it,
    with its `.env` as a Secret. Then wait until every agent is ready and show how
    to call the endpoint."""
    config_path = resolve_config(config_path)
    env_values = read_dotenv()
    config = load_config(config_path, env_values)
    k8s = config["kubernetes"]
    namespace = k8s["namespace"]
    require_operator()
    ensure_namespace(namespace)
    # Before naming the project: its name ends with the start of its project_id, as on
    # Docker, so two folders of the same name never share one in a namespace.
    save_project_id(config_path)
    project = resource_name(project_name())
    env_secret = _env_secret(k8s, project, env_values)
    if env_values and not k8s.get("env_secret"):
        apply([dotenv_secret(namespace, env_secret, project, env_values)])
    images = build_in_cluster(config_path, namespace, project_name(), k8s, env_secret)
    ui.ok(f"Built {len(images)} image(s) in the cluster and applied the project")
    project_obj, agents = wait_until_ready(namespace, project, timeout=timeout)
    ui.ok(f"{len(agents)} agent(s) ready on Kubernetes")
    for line in scaling_conflicts(agents):
        ui.warn(line)
    ui.panel(_summary(namespace, project_obj, config))
    return agents


def _namespace_and_project(config_path):
    config = load_config(resolve_config(config_path), read_dotenv())
    return config["kubernetes"]["namespace"], resource_name(project_name())


def run_kubernetes_status(as_json=False, config_path=None):
    """Run `canyonos status --target kubernetes`: the project and each agent's replicas
    and readiness in the terminal; with `as_json`, the object `canyonos status --json`
    prints on Docker instead. Returns True when the project is deployed."""
    ui.set_quiet(as_json)
    try:
        report = _kubernetes_status(config_path)
    finally:
        ui.set_quiet(False)
    if as_json:
        print(json.dumps(report, indent=2))
    return report["running"]


def _launch_error(agent):
    """Why an agent's replicas are not running, when the operator says so."""
    ready = condition(agent, "Ready")
    if ready.get("status") != "True" and (
        ready.get("reason") in FATAL_REASONS or ready.get("reason") == "Unschedulable"
    ):
        return ready.get("message")
    return None


def _kubernetes_status(config_path):
    report = {
        "running": False,
        "endpoint": None,
        "dashboard_url": None,
        "agents": None,
        "machine_errors": None,
        "errors": [],
    }
    namespace, project = _namespace_and_project(config_path)
    result = kubectl(
        ["get", "canyonproject", project, "-n", namespace, "-o", "json"], check=False
    )
    if result.returncode:
        ui.warn(f"No CanyonOS project {project!r} in namespace {namespace}")
        report["errors"].append((result.stderr or "").strip())
        return report
    report["running"] = True
    proj = json.loads(result.stdout)
    url = proj.get("status", {}).get("endpointURL")
    report["endpoint"] = {"url": url} if url else None
    ready = condition(proj, "Ready")
    state = (
        "Ready"
        if ready.get("status") == "True"
        else (ready.get("reason") or "Starting")
    )
    ui.ok(f"Project {project} in {namespace}: {state} · endpoint {url or '?'}")
    table = Table(title=None)
    for column in ("Agent", "Desired", "Ready", "State"):
        table.add_column(column)
    agents = project_agents(namespace, project)
    report["agents"] = {}
    for a in agents:
        spec, status = a.get("spec", {}), a.get("status", {})
        agent_ready = condition(a, "Ready")
        report["agents"][spec.get("agentName", "")] = {
            "desired_replicas": spec.get("replicas"),
            "running_replicas": status.get("readyReplicas", 0),
            "launch_error": _launch_error(a),
        }
        table.add_row(
            spec.get("agentName", ""),
            str(spec.get("replicas", "")),
            str(status.get("readyReplicas", 0)),
            "Ready"
            if agent_ready.get("status") == "True"
            else (agent_ready.get("message") or "Starting"),
        )
    ui.panel(table)
    for line in scaling_conflicts(agents):
        ui.warn(line)
    return report


def run_kubernetes_logs(follow=True, tail="200", agent=None, config_path=None):
    """Run `canyonos logs --target kubernetes`: the last `tail` lines of the Global
    Controller's logs, as on Docker, or of an agent's replicas or one replica (such
    as IntentAgent-1), and with `follow` keep streaming them until Ctrl-C. Returns
    True when kubectl could read them."""
    if tail != "all" and not str(tail).isdigit():
        raise RuntimeError(f"--tail takes a number of lines or `all`, not {tail!r}")
    namespace, project = _namespace_and_project(config_path)
    argv = ["kubectl", "logs", "-n", namespace, "--all-containers", "--prefix",
            f"--tail={-1 if tail == 'all' else tail}"]  # fmt: skip
    if follow:
        argv.append("-f")
    if not agent:
        argv.append(GLOBAL_CONTROLLER)
    elif (
        kubectl(
            ["get", "pod", resource_name(agent), "-n", namespace], check=False
        ).returncode
        == 0
    ):
        argv.append(f"pod/{resource_name(agent)}")  # one replica: its pod has its name
    else:
        argv += ["-l", f"{LABEL_PROJECT}={project},{LABEL_AGENT}={resource_name(agent)}",
                 "--max-log-requests=30"]  # fmt: skip
    return subprocess.call(argv) == 0


def run_kubernetes_stop(config_path=None):
    """Run `canyonos stop --target kubernetes`: delete the CanyonProject; the operator
    stops the endpoint, drains every agent, then removes Redis and the global
    controller. The namespace, config and Secret stay for the next deploy."""
    namespace, project = _namespace_and_project(config_path)
    with ui.status(f"Stopping {project} (agents drain first)..."):
        kubectl(
            [
                "delete",
                "canyonproject",
                project,
                "-n",
                namespace,
                "--ignore-not-found",
                "--timeout=15m",
            ],
            timeout=960,
        )
    ui.ok(f"Stopped {project} in {namespace}")
    return True


def run_kubernetes_serve(port=8081):
    """Run `canyonos serve --target kubernetes`: open the cluster's dashboard here
    through a port-forward, until Ctrl+C. Only who may port-forward into its
    namespace can open it."""
    found = kubectl(["get", DASHBOARD_SERVICE, "-n", DASHBOARD_NAMESPACE], check=False)
    if found.returncode:
        raise RuntimeError(
            f"No CanyonOS dashboard you can reach in namespace {DASHBOARD_NAMESPACE}: "
            "it is not installed (the operator's chart, --set dashboard.enabled=true; "
            "see docs/guides/KUBERNETES.md) or you may not open it there "
            f"({found.stderr.strip()})"
        )
    ui.ok(f"Dashboard: http://127.0.0.1:{port} (Ctrl+C to stop)")
    return subprocess.call(
        [
            "kubectl",
            "port-forward",
            "-n",
            DASHBOARD_NAMESPACE,
            DASHBOARD_SERVICE,
            f"{port}:8080",
        ]
    )


def run_kubernetes_clean(config_path=None):
    """Run `canyonos clean --target kubernetes`: stop the project and remove what the
    CLI created for it in the cluster (its ConfigMap and Secret); nothing here on this
    machine changes. The namespace stays: it may hold more than this project; the hint
    says how to remove one `canyonos deploy` made."""
    namespace, project = _namespace_and_project(config_path)
    run_kubernetes_stop(config_path)
    kubectl(
        ["delete", "configmap,secret", "-n", namespace, "-l",
         f"{LABEL_PROJECT}={project},{LABEL_MANAGED_BY}={MANAGED_BY}", "--ignore-not-found"]
    )  # fmt: skip
    ns = kubectl(["get", "namespace", namespace, "-o", "json"], check=False)
    labels = (
        json.loads(ns.stdout)["metadata"].get("labels", {})
        if ns.returncode == 0
        else {}
    )
    if labels.get(LABEL_MANAGED_BY) == MANAGED_BY:
        ui.hint(
            f"Namespace {namespace} was created by canyonos deploy and is left in place; "
            f"when nothing else uses it: kubectl delete namespace {namespace}"
        )
    return True
