# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos cluster up` and `down`: a local Kubernetes cluster to deploy to with
`--target kubernetes`, from the released CLI alone, with no CanyonOS checkout.

`up` makes what scripts/kind/up.sh makes for development (a registry on
localhost:5001, a kind cluster with Calico, metrics-server and Pod Security
`restricted`), then installs CanyonOS from the chart this CLI's release published, so
the cluster always runs the same release as the CLI. Helm runs in a container, so the
machine needs only Docker, kind and kubectl. A CLI from a checkout uses
scripts/kind/up.sh instead, which installs CanyonOS built from that checkout.
"""

import os
import subprocess
import tempfile
from pathlib import Path

import yaml

from canyonos import env, ui
from canyonos.kubernetes_target import kubectl

CLUSTER_ENV = "CANYONOS_KIND_CLUSTER"
# Keep these in step with scripts/kind/up.sh; tests/test_kubernetes_local.py checks it.
NODE_IMAGE = "kindest/node:v1.36.4@sha256:099e049362a1526b2db71494e1947aae99bd16290d7c895f2b7ea312e3cbfaed"
REGISTRY_IMAGE = "registry:3.1.1"
REGISTRY_NAME = "kind-registry"
REGISTRY_PORT = 5001
CALICO_VERSION = "v3.32.2"
METRICS_SERVER_VERSION = "v0.9.0"
# helm 3.17.3, pinned by digest, as scripts/kind/operator.sh runs it.
HELM_IMAGE = "alpine/helm@sha256:d899e6316789fec04ee95300a18e454b7942539cbb3d89bde3e0655d6ca2e895"
CHART = "oci://ghcr.io/canyoncodecoreai/charts/canyonos-operator"
NAMESPACE = "canyonos-system"
# The cluster's registry, as the builder reaches it inside the kind network (plain HTTP).
KIND_VALUES = (
    "--set", "builder.enabled=true",
    "--set", "builder.insecureRegistries={kind-registry:5000}",
    "--set", f"builder.registryAliases.localhost:{REGISTRY_PORT}=kind-registry:5000",
    "--set", "dashboard.enabled=true",
)  # fmt: skip
MIN_CPUS, MIN_MEMORY_MIB = 4, 7500


def cluster_name():
    return os.environ.get(CLUSTER_ENV) or "canyonos"


def config_dir():
    """Where the API server's Pod Security file is kept for the cluster's lifetime."""
    return Path.home() / ".canyonos" / "kind"


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


def _require_tools():
    hints = {
        "docker": "install Docker Desktop or Docker Engine",
        "kind": "https://kind.sigs.k8s.io/docs/user/quick-start/#installation "
        "(macOS: brew install kind; Windows: winget install Kubernetes.kind)",
        "kubectl": "https://kubernetes.io/docs/tasks/tools/ "
        "(macOS: brew install kubectl; Windows: winget install Kubernetes.kubectl)",
    }
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


def _clusters():
    return _run(["kind", "get", "clusters"]).stdout.split()


def _ensure_registry():
    running = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Running}}", REGISTRY_NAME],
        capture_output=True,
        text=True,
    )
    if running.stdout.strip() == "true":
        return
    subprocess.run(["docker", "rm", "-f", REGISTRY_NAME], capture_output=True)
    _run(
        ["docker", "run", "-d", "--restart=always",
         "-p", f"127.0.0.1:{REGISTRY_PORT}:5000", "--network", "bridge",
         "--name", REGISTRY_NAME, REGISTRY_IMAGE],
        what="Starting the local registry",
    )  # fmt: skip


def _keep_cluster(name, workers):
    nodes = _run(["kind", "get", "nodes", "--name", name]).stdout.split()
    have = sum("worker" in node for node in nodes)
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


def _connect_registry(name):
    """Point every node's localhost:5001 at the registry container, and tell tools
    where the cluster's registry is (KEP-1755)."""
    hosts = f'[host."http://{REGISTRY_NAME}:5000"]\n'
    folder = f"/etc/containerd/certs.d/localhost:{REGISTRY_PORT}"
    for node in _run(["kind", "get", "nodes", "--name", name]).stdout.split():
        _run(["docker", "exec", node, "mkdir", "-p", folder])
        _run(
            ["docker", "exec", "-i", node, "cp", "/dev/stdin", f"{folder}/hosts.toml"],
            input_text=hosts,
        )
    networks = _run(
        [
            "docker",
            "inspect",
            "-f",
            "{{json .NetworkSettings.Networks.kind}}",
            REGISTRY_NAME,
        ]
    ).stdout.strip()
    if networks == "null":
        _run(["docker", "network", "connect", "kind", REGISTRY_NAME])
    hosting = {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {"name": "local-registry-hosting", "namespace": "kube-public"},
        "data": {
            "localRegistryHosting.v1": f'host: "localhost:{REGISTRY_PORT}"\n'
            'help: "https://kind.sigs.k8s.io/docs/user/local-registry/"\n'
        },
    }
    kubectl(["apply", "-f", "-"], input_text=yaml.safe_dump(hosting))


def _install_networking():
    kubectl(
        ["apply", "--server-side", "-f",
         f"https://raw.githubusercontent.com/projectcalico/calico/{CALICO_VERSION}/manifests/calico.yaml"],
        timeout=300,
    )  # fmt: skip
    kubectl(
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
    kubectl(
        ["wait", "--for=condition=Ready", "nodes", "--all", "--timeout=300s"],
        timeout=330,
    )
    kubectl(
        ["apply", "-f",
         f"https://github.com/kubernetes-sigs/metrics-server/releases/download/{METRICS_SERVER_VERSION}/components.yaml"],
        timeout=300,
    )  # fmt: skip
    args = kubectl(
        ["-n", "kube-system", "get", "deployment", "metrics-server",
         "-o", "jsonpath={.spec.template.spec.containers[0].args}"],
    ).stdout  # fmt: skip
    if "kubelet-insecure-tls" not in args:
        # kind's kubelets serve self-signed certificates.
        kubectl(
            ["-n", "kube-system", "patch", "deployment", "metrics-server", "--type=json",
             '-p=[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'],
        )  # fmt: skip
    kubectl(
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


def _install_canyonos(name, version):
    """This release's chart, its CRDs applied first (Helm never upgrades them), and
    Helm waiting until the operator, the builder and the dashboard are ready."""
    with tempfile.TemporaryDirectory() as tmp:
        kubeconfig = Path(tmp) / "config"
        kubeconfig.write_text(
            _run(["kind", "get", "kubeconfig", "--internal", "--name", name]).stdout,
            encoding="utf-8",
        )
        helm = ["docker", "run", "--rm", "--network", "kind",
                "-v", f"{tmp}:/kube:ro", "-e", "KUBECONFIG=/kube/config", HELM_IMAGE]  # fmt: skip
        crds = _run(
            [*helm, "show", "crds", CHART, "--version", version],
            what=f"Reading the CanyonOS {version} chart (is {version} published?)",
        ).stdout
        kubectl(
            ["apply", "--server-side", "--force-conflicts", "-f", "-"], input_text=crds
        )
        _run(
            [*helm, "upgrade", "--install", "canyonos", CHART, "--version", version,
             "--namespace", NAMESPACE, "--create-namespace", *KIND_VALUES,
             "--wait", "--timeout", "10m"],
            timeout=900,
            what=f"Installing CanyonOS {version}",
        )  # fmt: skip


def run_cluster_up(workers=None):
    """Run `canyonos cluster up`: the local registry, the kind cluster and CanyonOS of
    this CLI's release on it, ready to deploy to. Safe to re-run: what exists is kept,
    and CanyonOS is upgraded to this CLI's release."""
    if env.is_development:
        raise RuntimeError(
            "This CLI runs from a checkout: run scripts/kind/up.sh there, which installs "
            "CanyonOS built from it (cluster up installs a published release)."
        )
    if workers is not None and workers < 1:
        raise RuntimeError("--workers takes 1 or more")
    name, version = cluster_name(), env.VERSION
    _require_tools()
    with ui.status(f"Starting the local registry on localhost:{REGISTRY_PORT}..."):
        _ensure_registry()
    if name in _clusters():
        _keep_cluster(name, workers)
    else:
        with ui.status(f"Creating the kind cluster {name} (a few minutes)..."):
            _create_cluster(name, workers or 1)
    _run(["kubectl", "config", "use-context", f"kind-{name}"])
    with ui.status("Connecting the nodes to the registry..."):
        _connect_registry(name)
    with ui.status("Installing Calico and metrics-server..."):
        _install_networking()
    with ui.status(
        f"Installing CanyonOS {version} (the operator, builder and dashboard)..."
    ):
        _install_canyonos(name, env.PROD_CHART_VERSION)
    ui.ok(f"Cluster {name} is ready, with CanyonOS {version}; kubectl now points at it")
    ui.say(
        "Deploy a project to it: add to its config/global_controller.yaml\n"
        "  kubernetes:\n"
        "    namespace: <a namespace for it, e.g. its name>\n"
        f"    registry: localhost:{REGISTRY_PORT}\n"
        "then run canyonos deploy --target kubernetes, and canyonos serve --target "
        "kubernetes for the dashboard. canyonos cluster down removes the cluster."
    )
    return True


def run_cluster_down(remove_registry=False):
    """Run `canyonos cluster down`: delete the local kind cluster, and with
    `remove_registry` the registry container and the images in it."""
    name = cluster_name()
    if name in _clusters():
        with ui.status(f"Deleting the kind cluster {name}..."):
            _run(["kind", "delete", "cluster", "--name", name], timeout=600)
        ui.ok(f"Deleted the kind cluster {name}")
    else:
        ui.say(f"No kind cluster {name}")
    if remove_registry:
        subprocess.run(["docker", "rm", "-f", REGISTRY_NAME], capture_output=True)
        ui.ok(f"Removed the registry {REGISTRY_NAME}")
    return True
