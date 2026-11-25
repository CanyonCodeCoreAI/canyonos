# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos cluster up` and `down`: a local Kubernetes cluster to deploy to with
`target: kubernetes`, from the released CLI alone, with no CanyonOS checkout.

`up` makes what scripts/kind/up.sh makes for development (a registry on
localhost:5001, a kind cluster with Calico, metrics-server and Pod Security
`restricted`), then installs CanyonOS from the chart this CLI's release published, so
the cluster always runs the same release as the CLI. Helm runs in a container, so the
machine needs only Docker, kind and kubectl. A CLI from a checkout uses
scripts/kind/up.sh instead, which installs CanyonOS built from that checkout.

`up --k3d` makes the k3d cluster the platform's local stack makes (canyoncode
packages/platform-api/scripts/local-stack.ts, `bun run platform:up -- --cluster`), so the
two share one cluster, whichever makes it first: `canyonos`, one node, its registry
`k3d-canyonos-registry` on localhost:5001, no Traefik or servicelb, and no Pod Security
`restricted` (it's for trying CanyonOS, not testing it against a strict cluster). k3s
enforces NetworkPolicy and ships metrics-server itself. It leaves kubectl's current
context alone: the cluster is `k3d-canyonos`. `down` deletes the cluster whichever made
it.
"""

import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import yaml

from canyonos import env, ui
from canyonos.deployment import LOCAL_KUBERNETES
from canyonos.forwards import close_forwards_to
from canyonos.kubernetes_target import ADMIN_ACCOUNT, kubectl

CLUSTER_ENV = "CANYONOS_KIND_CLUSTER"
# What makes the cluster: kind by default, k3d with `cluster up --k3d`.
KIND, K3D = "kind", "k3d"
ENGINES = (KIND, K3D)
# The same Kubernetes release as NODE_IMAGE.
K3S_IMAGE = "rancher/k3s:v1.36.4-k3s1@sha256:edad48e12bf81c3a09ac1c05c0c0ffaaa22145980b989d6fae84543a76b83657"
# Keep these in step with scripts/kind/up.sh; tests/test_kubernetes_local.py checks it.
NODE_IMAGE = "kindest/node:v1.36.4@sha256:099e049362a1526b2db71494e1947aae99bd16290d7c895f2b7ea312e3cbfaed"
REGISTRY_IMAGE = "registry:3.1.1"
REGISTRY_NAME = "kind-registry"
# k3d names its registry containers k3d-<name>: the platform's local stack's.
REGISTRY_PORT = 5001
CALICO_VERSION = "v3.32.2"
METRICS_SERVER_VERSION = "v0.9.0"
# helm 3.17.3, pinned by digest, as scripts/kind/operator.sh runs it.
HELM_IMAGE = "alpine/helm@sha256:d899e6316789fec04ee95300a18e454b7942539cbb3d89bde3e0655d6ca2e895"
CHART = "oci://ghcr.io/canyoncodecoreai/charts/canyonos-operator"
NAMESPACE = "canyonos-system"
MIN_CPUS, MIN_MEMORY_MIB = 4, 7500


def cluster_name():
    return os.environ.get(CLUSTER_ENV) or "canyonos"


def config_dir(engine=KIND):
    """Where the cluster's files are kept for its lifetime: kind's Pod Security file, k3d's
    registry mirror."""
    return Path.home() / ".canyonos" / engine


def context_name(engine, name):
    """The kubectl context the engine names the cluster's: kind-canyonos, k3d-canyonos."""
    return f"{engine}-{name}"


def _kubeconfig_user(engine, name):
    return f"kind-{name}" if engine == KIND else f"admin@k3d-{name}"


def registry_name(engine, name):
    """The registry container: kind's, or k3d's for the cluster."""
    return REGISTRY_NAME if engine == KIND else f"k3d-{name}-registry"


def chart_values(engine, name):
    """The chart's values for the cluster's registry, as the builder reaches it on the
    cluster's network (plain HTTP)."""
    registry = registry_name(engine, name)
    return (
        "--set", "builder.enabled=true",
        "--set", f"builder.insecureRegistries={{{registry}:5000}}",
        "--set", f"builder.registryAliases.localhost:{REGISTRY_PORT}={registry}:5000",
        "--set", "dashboard.enabled=true",
    )  # fmt: skip


def _kubectl_for(engine, name):
    """kubectl on the cluster's context, whatever kubectl's current one is."""
    context = context_name(engine, name)

    def run(args, **kwargs):
        return kubectl(["--context", context, *args], **kwargs)

    return run


def _network(engine, name):
    """The Docker network the engine puts the cluster's nodes on."""
    return "kind" if engine == KIND else f"k3d-{name}"


def pod_security_config():
    """Pod Security `restricted` for every namespace, as OpenShift enforces by default;
    kube-system (Calico, metrics-server) and kind's volume provisioner are exempt."""
    levels = {}
    for mode in ("enforce", "audit", "warn"):
        levels[mode] = "restricted"
        levels[f"{mode}-version"] = "latest"
    return {
        "apiVersion": "apiserver.config.k8s.io/v1",
        "kind": "AdmissionConfiguration",
        "plugins": [
            {
                "name": "PodSecurity",
                "configuration": {
                    "apiVersion": "pod-security.admission.config.k8s.io/v1",
                    "kind": "PodSecurityConfiguration",
                    "defaults": levels,
                    "exemptions": {
                        "usernames": [],
                        "runtimeClasses": [],
                        "namespaces": ["kube-system", "local-path-storage"],
                    },
                },
            }
        ],
    }


def cluster_config(pod_security_dir, workers=1):
    """The kind cluster: Calico instead of kindnet (which ignores NetworkPolicy), nodes
    reading registry hosts from /etc/containerd/certs.d, and the API server enforcing
    the Pod Security file mounted from `pod_security_dir`."""
    admission = (
        "kind: ClusterConfiguration\n"
        "apiServer:\n"
        "  extraArgs:\n"
        "    - name: admission-control-config-file\n"
        "      value: /etc/kubernetes/canyonos/pod-security.yaml\n"
        "  extraVolumes:\n"
        "    - name: canyonos-admission\n"
        "      hostPath: /etc/kubernetes/canyonos\n"
        "      mountPath: /etc/kubernetes/canyonos\n"
        "      readOnly: true\n"
        "      pathType: Directory\n"
    )
    registry = (
        '[plugins."io.containerd.grpc.v1.cri".registry]\n'
        '  config_path = "/etc/containerd/certs.d"'
    )
    control_plane = {
        "role": "control-plane",
        "extraMounts": [
            {
                "hostPath": Path(pod_security_dir).as_posix(),
                "containerPath": "/etc/kubernetes/canyonos",
                "readOnly": True,
            }
        ],
        "kubeadmConfigPatches": [admission],
    }
    return {
        "kind": "Cluster",
        "apiVersion": "kind.x-k8s.io/v1alpha4",
        "name": "canyonos",
        "networking": {"disableDefaultCNI": True, "podSubnet": "192.168.0.0/16"},
        "containerdConfigPatches": [registry],
        "nodes": [control_plane] + [{"role": "worker"} for _ in range(workers)],
    }


def _run(argv, *, input_text=None, timeout=600, what=None):
    """Run a command, failing with its own error output."""
    try:
        result = subprocess.run(
            argv,
            input=input_text,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except FileNotFoundError:
        raise RuntimeError(f"{argv[0]} is not installed or not on PATH") from None
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"{what or argv[0]} timed out after {timeout}s") from None
    if result.returncode:
        detail = (result.stderr or result.stdout).strip()
        raise RuntimeError(f"{what or ' '.join(argv[:3])} failed: {detail}")
    return result


TOOL_HINTS = {
    "docker": "install Docker Desktop or Docker Engine",
    KIND: "https://kind.sigs.k8s.io/docs/user/quick-start/#installation "
    "(macOS: brew install kind; Windows: winget install Kubernetes.kind)",
    K3D: "https://k3d.io/stable/#installation "
    "(macOS: brew install k3d; Linux: its install script; Windows: choco install k3d)",
    "kubectl": "https://kubernetes.io/docs/tasks/tools/ "
    "(macOS: brew install kubectl; Windows: winget install Kubernetes.kubectl)",
}


def _require_tools(engine=KIND):
    hints = {tool: TOOL_HINTS[tool] for tool in ("docker", engine, "kubectl")}
    for tool, hint in hints.items():
        try:
            subprocess.run([tool, "version"], capture_output=True, timeout=30)
        except (FileNotFoundError, subprocess.TimeoutExpired):
            raise RuntimeError(f"{tool} is needed: {hint}") from None
    info = subprocess.run(
        ["docker", "info", "--format", "{{.NCPU}} {{.MemTotal}}"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if info.returncode:
        raise RuntimeError("Docker is not running: start Docker Desktop and try again")
    cpus, memory = (int(n) for n in info.stdout.split())
    if cpus < MIN_CPUS or memory // 2**20 < MIN_MEMORY_MIB:
        ui.warn(
            f"Docker has {cpus} CPUs and {memory // 2**30} GB: CanyonOS with its builder "
            "and dashboard wants at least 4 CPUs and 8 GB (Docker Desktop: Settings > "
            "Resources), or deploys may wait for room."
        )


def _clusters(engine=KIND):
    """The engine's clusters on this machine, by name."""
    if engine == KIND:
        return _run(["kind", "get", "clusters"]).stdout.split()
    listed = _run(["k3d", "cluster", "list", "-o", "json"]).stdout
    return [cluster["name"] for cluster in json.loads(listed or "[]")]


def _port_holder():
    """The container publishing the registry's port, if one does."""
    listed = subprocess.run(
        [
            "docker",
            "ps",
            "--filter",
            f"publish={REGISTRY_PORT}",
            "--format",
            "{{.Names}}",
        ],
        capture_output=True,
        text=True,
    )
    return listed.stdout.split()[0] if listed.stdout.split() else None


def _ensure_registry(engine=KIND, name=None):
    """The cluster's registry on localhost:5001, started or made. Another container on
    that port (the other engine's registry) is named rather than fought over."""
    registry = registry_name(engine, name or cluster_name())
    running = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Running}}", registry],
        capture_output=True,
        text=True,
    )
    if running.stdout.strip() == "true":
        return
    holder = _port_holder()
    if holder and holder != registry:
        raise RuntimeError(
            f"localhost:{REGISTRY_PORT} is taken by the container {holder}. "
            + (
                "It's k3d's registry: make the cluster with canyonos cluster up --k3d, "
                "or remove it first."
                if holder.startswith("k3d-")
                else "It's kind's registry: canyonos cluster down --all removes it."
                if holder == REGISTRY_NAME
                else "Stop it, then try again."
            )
        )
    if running.stdout.strip() == "false":
        _run(["docker", "start", registry], what="Starting the local registry")
        return
    if engine == K3D:
        _run(
            ["k3d", "registry", "create", f"{name or cluster_name()}-registry",
             "--port", f"127.0.0.1:{REGISTRY_PORT}"],
            what="Making the local registry",
        )  # fmt: skip
        return
    subprocess.run(["docker", "rm", "-f", REGISTRY_NAME], capture_output=True)
    _run(
        ["docker", "run", "-d", "--restart=always",
         "-p", f"127.0.0.1:{REGISTRY_PORT}:5000", "--network", "bridge",
         "--name", REGISTRY_NAME, REGISTRY_IMAGE],
        what="Starting the local registry",
    )  # fmt: skip


def _keep_cluster(engine, name, workers):
    if engine == KIND:
        nodes = _run(["kind", "get", "nodes", "--name", name]).stdout.split()
        have = sum("worker" in node for node in nodes)
    else:
        nodes = json.loads(_run(["k3d", "node", "list", "-o", "json"]).stdout or "[]")
        have = sum(
            node.get("role") == "agent"
            and node.get("runtimeLabels", {}).get("k3d.cluster") == name
            for node in nodes
        )
    ui.say(f"Cluster {name} already exists, with {have} worker(s)")
    if workers is not None and have != workers:
        ui.hint("--workers applies to a new cluster: canyonos cluster down, then up")


def _create_cluster(name, workers):
    folder = config_dir()
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "pod-security.yaml").write_text(
        yaml.safe_dump(pod_security_config(), sort_keys=False), encoding="utf-8"
    )
    with tempfile.TemporaryDirectory() as tmp:
        config = Path(tmp) / "cluster.yaml"
        config.write_text(
            yaml.safe_dump(cluster_config(folder, workers), sort_keys=False),
            encoding="utf-8",
        )
        _run(
            ["kind", "create", "cluster", "--name", name, "--image", NODE_IMAGE,
             "--config", str(config), "--wait", "0s"],
            timeout=900,
            what=f"Creating the kind cluster {name}",
        )  # fmt: skip


def k3d_registries(name):
    """k3s's registry mirror: localhost:5001, as the builder pushes to it, pulled from the
    cluster's registry container on its network."""
    return {
        "mirrors": {
            f"localhost:{REGISTRY_PORT}": {
                "endpoint": [f"http://{registry_name(K3D, name)}:5000"]
            }
        }
    }


def k3d_create_command(name, workers, folder):
    """`k3d cluster create` as the platform's local stack runs it: one node and no load
    balancer (`workers` adds agents), its registry and mirror, no Traefik or servicelb,
    and kubectl's current context left as it is."""
    on_server = "@server:0"
    return [
        "k3d", "cluster", "create", name, "--image", K3S_IMAGE,
        "--agents", str(workers), "--no-lb",
        "--registry-use", f"{registry_name(K3D, name)}:{REGISTRY_PORT}",
        "--registry-config", str(Path(folder) / "registries.yaml"),
        "--k3s-arg", f"--disable=traefik{on_server}",
        "--k3s-arg", f"--disable=servicelb{on_server}",
        "--kubeconfig-update-default", "--kubeconfig-switch-context=false",
        "--wait", "--timeout", "600s",
    ]  # fmt: skip


def _create_k3d_cluster(name, workers):
    folder = config_dir(K3D)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "registries.yaml").write_text(
        yaml.safe_dump(k3d_registries(name), sort_keys=False), encoding="utf-8"
    )
    _run(
        k3d_create_command(name, workers, folder),
        timeout=900,
        what=f"Creating the k3d cluster {name}",
    )


def _sign_in_with_token(engine, name):
    """Give the cluster an admin service account, and have its context sign in with its
    token, which canyonos can send, instead of the engine's client certificate."""
    k = _kubectl_for(engine, name)
    account = {
        "apiVersion": "v1",
        "kind": "ServiceAccount",
        "metadata": {"name": ADMIN_ACCOUNT, "namespace": "kube-system"},
    }
    binding = {
        "apiVersion": "rbac.authorization.k8s.io/v1",
        "kind": "ClusterRoleBinding",
        "metadata": {"name": ADMIN_ACCOUNT},
        "roleRef": {
            "apiGroup": "rbac.authorization.k8s.io",
            "kind": "ClusterRole",
            "name": "cluster-admin",
        },
        "subjects": [{"kind": "ServiceAccount", **account["metadata"]}],
    }
    k(["apply", "-f", "-"], input_text=yaml.safe_dump_all([account, binding]))
    token = k(
        ["-n", "kube-system", "create", "token", ADMIN_ACCOUNT, "--duration=87600h"]
    ).stdout.strip()
    # The engine's own user name, so deleting the cluster removes it too.
    user = _kubeconfig_user(engine, name)
    k(["config", "delete-user", user])
    k(["config", "set-credentials", user, f"--token={token}"])


def _make_local_namespace(engine, name):
    """The namespace `deploy --target kubernetes` gives a workflow group without a
    `kubernetes:` block (LOCAL_KUBERNETES): the cluster's CanyonOS API deploys only into
    a namespace that's there."""
    namespace = {
        "apiVersion": "v1",
        "kind": "Namespace",
        "metadata": {
            "name": LOCAL_KUBERNETES["namespace"],
            "labels": {"app.kubernetes.io/managed-by": "canyonos-cli"},
        },
    }
    _kubectl_for(engine, name)(
        ["apply", "-f", "-"], input_text=yaml.safe_dump(namespace)
    )


def _connect_registry(engine, name):
    """Point every node's localhost:5001 at the registry container (k3d's nodes read it
    from the registries.yaml they were made with), put the registry on the cluster's
    network, and tell tools where the cluster's registry is (KEP-1755)."""
    k = _kubectl_for(engine, name)
    if engine == KIND:
        hosts = f'[host."http://{REGISTRY_NAME}:5000"]\n'
        folder = f"/etc/containerd/certs.d/localhost:{REGISTRY_PORT}"
        for node in _run(["kind", "get", "nodes", "--name", name]).stdout.split():
            _run(["docker", "exec", node, "mkdir", "-p", folder])
            _run(
                [
                    "docker", "exec", "-i", node, "cp", "/dev/stdin",
                    f"{folder}/hosts.toml",
                ],
                input_text=hosts,
            )  # fmt: skip
    network = _network(engine, name)
    joined = json.loads(
        _run(
            [
                "docker",
                "inspect",
                "-f",
                "{{json .NetworkSettings.Networks}}",
                registry_name(engine, name),
            ]
        ).stdout
        or "{}"
    )
    if network not in joined:
        _run(["docker", "network", "connect", network, registry_name(engine, name)])
    hosting = {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {"name": "local-registry-hosting", "namespace": "kube-public"},
        "data": {
            "localRegistryHosting.v1": f'host: "localhost:{REGISTRY_PORT}"\n'
            'help: "https://kind.sigs.k8s.io/docs/user/local-registry/"\n'
        },
    }
    k(["apply", "-f", "-"], input_text=yaml.safe_dump(hosting))


def _install_networking(engine, name):
    k = _kubectl_for(engine, name)
    if engine == K3D:
        # k3s brings its own network (with NetworkPolicy) and metrics-server.
        k(
            ["wait", "--for=condition=Ready", "nodes", "--all", "--timeout=300s"],
            timeout=330,
        )
        # k3s's add-on controller makes it a little after the nodes are Ready, and
        # `rollout status` fails at once on a deployment not made yet.
        _wait_until_made(k, "kube-system", "deployment/metrics-server")
        k(
            ["-n", "kube-system", "rollout", "status", "deployment/metrics-server",
             "--timeout=300s"],
            timeout=330,
        )  # fmt: skip
        return
    k(
        ["apply", "--server-side", "-f",
         f"https://raw.githubusercontent.com/projectcalico/calico/{CALICO_VERSION}/manifests/calico.yaml"],
        timeout=300,
    )  # fmt: skip
    k(
        [
            "-n",
            "kube-system",
            "rollout",
            "status",
            "daemonset/calico-node",
            "--timeout=300s",
        ],
        timeout=330,
    )
    k(
        ["wait", "--for=condition=Ready", "nodes", "--all", "--timeout=300s"],
        timeout=330,
    )
    k(
        ["apply", "-f",
         f"https://github.com/kubernetes-sigs/metrics-server/releases/download/{METRICS_SERVER_VERSION}/components.yaml"],
        timeout=300,
    )  # fmt: skip
    args = k(
        ["-n", "kube-system", "get", "deployment", "metrics-server",
         "-o", "jsonpath={.spec.template.spec.containers[0].args}"],
    ).stdout  # fmt: skip
    if "kubelet-insecure-tls" not in args:
        # kind's kubelets serve self-signed certificates.
        k(
            ["-n", "kube-system", "patch", "deployment", "metrics-server", "--type=json",
             '-p=[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'],
        )  # fmt: skip
    k(
        [
            "-n",
            "kube-system",
            "rollout",
            "status",
            "deployment/metrics-server",
            "--timeout=300s",
        ],
        timeout=330,
    )


def _wait_until_made(k, namespace, resource, timeout=300):
    """Wait until `resource` (`deployment/metrics-server`) is there in `namespace`."""
    deadline = time.monotonic() + timeout
    while k(["-n", namespace, "get", resource, "-o", "name"], check=False).returncode:
        if time.monotonic() > deadline:
            raise RuntimeError(
                f"The cluster didn't make {resource} in {namespace} within {timeout}s: "
                "run canyonos cluster up again"
            )
        time.sleep(2)


def _internal_kubeconfig(engine, name):
    """The cluster's kubeconfig as a container on its network reaches it."""
    if engine == KIND:
        return _run(["kind", "get", "kubeconfig", "--internal", "--name", name]).stdout
    config = yaml.safe_load(_run(["k3d", "kubeconfig", "get", name]).stdout)
    for cluster in config.get("clusters", []):
        cluster["cluster"]["server"] = f"https://k3d-{name}-server-0:6443"
    return yaml.safe_dump(config)


def _install_canyonos(engine, name, version):
    """This release's chart, its CRDs with it, and Helm waiting until the operator, the
    builder and the dashboard are ready. --take-ownership: a cluster made by a CLI up to
    0.2.x has the CRDs already, outside the Helm release."""
    with tempfile.TemporaryDirectory() as tmp:
        kubeconfig = Path(tmp) / "config"
        kubeconfig.write_text(_internal_kubeconfig(engine, name), encoding="utf-8")
        helm = ["docker", "run", "--rm", "--network", _network(engine, name),
                "-v", f"{tmp}:/kube:ro", "-e", "KUBECONFIG=/kube/config", HELM_IMAGE]  # fmt: skip
        _run(
            [*helm, "upgrade", "--install", "canyonos", CHART, "--version", version,
             "--namespace", NAMESPACE, "--create-namespace", "--take-ownership",
             *chart_values(engine, name), "--wait", "--timeout", "10m"],
            timeout=900,
            what=f"Installing CanyonOS {version}",
        )  # fmt: skip


def run_cluster_up(workers=None, engine=KIND):
    """Run `canyonos cluster up`: the local registry, the cluster (kind, or k3d with
    `engine`) and CanyonOS of this CLI's release on it, ready to deploy to. Safe to
    re-run: what exists is kept, and CanyonOS is upgraded to this CLI's release."""
    if env.is_development:
        raise RuntimeError(
            "This CLI runs from a checkout: run scripts/kind/up.sh there, which installs "
            "CanyonOS built from it (cluster up installs a published release)."
        )
    if workers is not None and workers < 1:
        raise RuntimeError("--workers takes 1 or more")
    name, version = cluster_name(), env.VERSION
    other = K3D if engine == KIND else KIND
    if shutil.which(other) and name in _clusters(other):
        raise RuntimeError(
            f"A {other} cluster {name} is already here: canyonos cluster down, then "
            f"cluster up{' --k3d' if engine == K3D else ''}."
        )
    _require_tools(engine)
    with ui.status(f"Starting the local registry on localhost:{REGISTRY_PORT}..."):
        _ensure_registry(engine, name)
    if name in _clusters(engine):
        _keep_cluster(engine, name, workers)
    else:
        with ui.status(f"Creating the {engine} cluster {name} (a few minutes)..."):
            if engine == KIND:
                _create_cluster(name, workers or 1)
            else:
                _create_k3d_cluster(name, workers or 0)
    if engine == KIND:
        _run(["kubectl", "config", "use-context", context_name(engine, name)])
    else:
        # A cluster the platform's local stack stopped starts again.
        _run(["k3d", "cluster", "start", name, "--wait"], timeout=600)
    _sign_in_with_token(engine, name)
    _make_local_namespace(engine, name)
    with ui.status("Connecting the nodes to the registry..."):
        _connect_registry(engine, name)
    with ui.status(
        "Installing Calico and metrics-server..."
        if engine == KIND
        else "Waiting for the nodes and metrics-server..."
    ):
        _install_networking(engine, name)
    with ui.status(
        f"Installing CanyonOS {version} (the operator, builder and dashboard)..."
    ):
        _install_canyonos(engine, name, env.PROD_CHART_VERSION)
    ui.json_result["cluster"] = {
        "name": name,
        "engine": engine,
        "context": context_name(engine, name),
    }
    ui.ok(
        f"{engine} cluster {name} is ready, with CanyonOS {version}; kubectl now points "
        "at it"
        if engine == KIND
        else f"k3d cluster {name} is ready, with CanyonOS {version}, as the context "
        f"{context_name(engine, name)}; kubectl's current context is unchanged"
    )
    ui.hint(
        "Its dashboard opens each workflow group's workflows with that workflow "
        "group's API key, which `canyonos deploy --api-key` sets."
    )
    if engine == K3D:
        ui.hint(
            f"canyonos deploys to kubectl's current context: kubectl config use-context "
            f"{context_name(engine, name)} first, or set KUBECONFIG to a file naming it."
        )
    ui.say(
        "Deploy to it: set `target: kubernetes` and a `kubernetes:` section in the "
        "workflow group's workflow_group.yaml, then run canyonos deploy <workflow "
        "folder>..., and canyonos serve for the dashboard. canyonos cluster down removes "
        "the cluster."
    )
    return True


def run_cluster_down(remove_registry=False):
    """Run `canyonos cluster down`: delete the local cluster, made by kind or k3d, and
    with `remove_registry` the registry container and the images in it."""
    name = cluster_name()
    deleted = False
    for engine in ENGINES:
        if not shutil.which(engine) or name not in _clusters(engine):
            continue
        with ui.status(f"Deleting the {engine} cluster {name}..."):
            if engine == KIND:
                _run(["kind", "delete", "cluster", "--name", name], timeout=600)
            else:
                _run(["k3d", "cluster", "delete", name], timeout=600)
        close_forwards_to(context_name(engine, name))
        ui.ok(f"Deleted the {engine} cluster {name}")
        if engine == K3D:
            ui.hint(
                "The platform's local stack shares this cluster: bun run platform:up -- "
                "--cluster makes it again."
            )
        deleted = True
    if not deleted:
        ui.say(f"No kind or k3d cluster {name}")
    if remove_registry:
        for registry in (REGISTRY_NAME, registry_name(K3D, name)):
            removed = subprocess.run(
                ["docker", "rm", "-f", registry], capture_output=True
            )
            if removed.returncode == 0:
                ui.ok(f"Removed the registry {registry}")
    return True
