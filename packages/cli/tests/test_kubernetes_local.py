# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos cluster up` and `down`: the commands they run, with no Docker, kind or
cluster touched, and that they make the same cluster as scripts/kind/up.sh."""

import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos import kubernetes_local

SCRIPTS = Path(__file__).resolve().parents[3] / "scripts" / "kind"


class FakeTools:
    """docker, kind, kubectl and helm answering from a laptop's state, recording every
    call and the cluster config kind was given."""

    def __init__(self, clusters=(), registry_running=False, workers=1):
        self.clusters, self.registry_running = list(clusters), registry_running
        self.nodes = ["canyonos-control-plane"] + [
            f"canyonos-worker{n or ''}" for n in range(workers)
        ]
        self.calls, self.inputs, self.cluster_config = [], {}, None

    def run(self, argv, **kwargs):
        self.calls.append(argv)
        if kwargs.get("input") is not None:
            self.inputs[" ".join(argv)] = kwargs["input"]
        command, out = " ".join(argv), ""
        if command.startswith("docker info"):
            out = f"8 {16 * 2**30}"
        elif command == "kind get clusters":
            out = "\n".join(self.clusters)
        elif "{{.State.Running}}" in command:
            out = "true" if self.registry_running else ""
        elif command.startswith("kind get nodes"):
            out = "\n".join(self.nodes)
        elif "Networks.kind" in command:
            out = "null"
        elif command.startswith("kind get kubeconfig"):
            out = "apiVersion: v1\n"
        elif "show crds" in command:
            out = "kind: CustomResourceDefinition\n"
        elif command.startswith("kind create cluster"):
            config = argv[argv.index("--config") + 1]
            self.cluster_config = yaml.safe_load(
                Path(config).read_text(encoding="utf-8")
            )
        return SimpleNamespace(returncode=0, stdout=out, stderr="")

    def ran(self, *start):
        return [argv for argv in self.calls if argv[: len(start)] == list(start)]


@pytest.fixture
def tools(monkeypatch, tmp_path):
    def make(**state):
        fake = FakeTools(**state)
        monkeypatch.setattr(kubernetes_local.subprocess, "run", fake.run)
        return fake

    monkeypatch.setattr(kubernetes_local.env, "is_development", False)
    monkeypatch.setattr(kubernetes_local.env, "VERSION", "0.1.740")
    monkeypatch.setattr(kubernetes_local, "config_dir", lambda: tmp_path / "kind")
    monkeypatch.delenv(kubernetes_local.CLUSTER_ENV, raising=False)
    return make


def test_up_makes_the_registry_and_cluster_and_installs_this_release(tools, tmp_path):
    fake = tools()
    assert kubernetes_local.run_cluster_up(workers=2)

    [registry] = fake.ran("docker", "run", "-d")
    assert registry[-2:] == ["kind-registry", "registry:3.1.1"]
    assert "127.0.0.1:5001:5000" in registry
    [create] = fake.ran("kind", "create", "cluster")
    assert create[create.index("--name") + 1] == "canyonos"
    assert [node["role"] for node in fake.cluster_config["nodes"]] == [
        "control-plane", "worker", "worker",
    ]  # fmt: skip
    pod_security = yaml.safe_load((tmp_path / "kind" / "pod-security.yaml").read_text())
    assert pod_security == kubernetes_local.pod_security_config()
    assert fake.ran("kubectl", "config", "use-context", "kind-canyonos")

    # Every node pulls localhost:5001 from the registry container.
    hosts = [
        text for command, text in fake.inputs.items() if command.endswith("hosts.toml")
    ]
    assert hosts == ['[host."http://kind-registry:5000"]\n'] * 2
    assert fake.ran("docker", "network", "connect", "kind", "kind-registry")

    # The chart of this CLI's release, its CRDs first, through Helm on the kind network.
    [crds] = [argv for argv in fake.calls if "show" in argv and "crds" in argv]
    [install] = [argv for argv in fake.calls if "upgrade" in argv]
    for helm in (crds, install):
        assert helm[:5] == ["docker", "run", "--rm", "--network", "kind"]
        assert kubernetes_local.HELM_IMAGE in helm
        assert helm[helm.index(kubernetes_local.CHART) + 2] == "0.1.740"
    assert fake.calls.index(crds) < fake.calls.index(install)
    applied = fake.inputs["kubectl apply --server-side --force-conflicts -f -"]
    assert applied == "kind: CustomResourceDefinition\n"
    for value in (
        "builder.enabled=true",
        "builder.insecureRegistries={kind-registry:5000}",
        "builder.registryAliases.localhost:5001=kind-registry:5000",
        "dashboard.enabled=true",
    ):
        assert value in install
    assert install[install.index("--namespace") + 1] == "canyonos-system"
    assert "--wait" in install


def test_up_keeps_what_exists(tools):
    fake = tools(clusters=["canyonos"], registry_running=True)
    assert kubernetes_local.run_cluster_up()
    assert not fake.ran("docker", "run", "-d")
    assert not fake.ran("kind", "create")
    assert [argv for argv in fake.calls if "upgrade" in argv]


@pytest.mark.parametrize("workers, warned", [(None, False), (2, False), (3, True)])
def test_workers_of_an_existing_cluster_are_kept(tools, monkeypatch, workers, warned):
    """--workers given for a cluster that has another count says how to change it;
    left out, the cluster's own count is fine."""
    tools(clusters=["canyonos"], registry_running=True, workers=2)
    hints = []
    monkeypatch.setattr(kubernetes_local.ui, "hint", hints.append)
    kubernetes_local.run_cluster_up(workers)
    assert bool([h for h in hints if "--workers" in h]) == warned


def test_up_uses_the_cluster_named_in_the_environment(tools, monkeypatch):
    monkeypatch.setenv(kubernetes_local.CLUSTER_ENV, "canyonos-try")
    fake = tools()
    kubernetes_local.run_cluster_up()
    [create] = fake.ran("kind", "create", "cluster")
    assert create[create.index("--name") + 1] == "canyonos-try"
    assert fake.ran("kubectl", "config", "use-context", "kind-canyonos-try")


def test_up_from_a_checkout_points_to_the_dev_script(tools, monkeypatch):
    fake = tools()
    monkeypatch.setattr(kubernetes_local.env, "is_development", True)
    with pytest.raises(RuntimeError, match="scripts/kind/up.sh"):
        kubernetes_local.run_cluster_up()
    assert fake.calls == []


def test_up_needs_a_worker(tools):
    with pytest.raises(RuntimeError, match="--workers"):
        kubernetes_local.run_cluster_up(workers=0)


def test_an_unpublished_release_says_so(tools, monkeypatch):
    fake = tools()

    def run(argv, **kwargs):
        if "show" in argv and "crds" in argv:
            return SimpleNamespace(returncode=1, stdout="", stderr="not found")
        return fake.run(argv, **kwargs)

    monkeypatch.setattr(kubernetes_local.subprocess, "run", run)
    with pytest.raises(RuntimeError, match="is 0.1.740 published.*not found"):
        kubernetes_local.run_cluster_up()


def test_a_missing_tool_says_how_to_install_it(tools, monkeypatch):
    def run(argv, **kwargs):
        if argv[0] == "kind":
            raise FileNotFoundError(argv[0])
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    tools()
    monkeypatch.setattr(kubernetes_local.subprocess, "run", run)
    with pytest.raises(RuntimeError, match="kind is needed: https://kind.sigs.k8s.io"):
        kubernetes_local.run_cluster_up()


@pytest.mark.parametrize("remove_registry", [False, True])
def test_down_deletes_the_cluster(tools, remove_registry):
    fake = tools(clusters=["canyonos"])
    assert kubernetes_local.run_cluster_down(remove_registry)
    assert fake.ran("kind", "delete", "cluster", "--name", "canyonos")
    assert bool(fake.ran("docker", "rm", "-f", "kind-registry")) == remove_registry


def test_down_without_a_cluster_deletes_nothing(tools):
    fake = tools()
    assert kubernetes_local.run_cluster_down()
    assert not fake.ran("kind", "delete")


def test_the_cluster_is_the_one_up_sh_makes():
    """The configs and pinned versions here are scripts/kind's, so a release's cluster
    and a developer's are the same."""
    folder = "C:/Users/someone/.canyonos/kind"
    script = yaml.safe_load(
        (SCRIPTS / "cluster.yaml").read_text().replace("__CONFIG__", folder)
    )
    assert kubernetes_local.cluster_config(Path(folder)) == script
    assert kubernetes_local.pod_security_config() == yaml.safe_load(
        (SCRIPTS / "pod-security.yaml").read_text()
    )

    up = (SCRIPTS / "up.sh").read_text()
    for name in (
        "REGISTRY_IMAGE",
        "REGISTRY_NAME",
        "CALICO_VERSION",
        "METRICS_SERVER_VERSION",
    ):
        assert f'{name}="{getattr(kubernetes_local, name)}"' in up
    assert f'REGISTRY_PORT="{kubernetes_local.REGISTRY_PORT}"' in up
    assert f"{{KIND_NODE_IMAGE:-{kubernetes_local.NODE_IMAGE}}}" in up
    operator = (SCRIPTS / "operator.sh").read_text()
    assert kubernetes_local.HELM_IMAGE in operator
    assert kubernetes_local.CHART in operator
