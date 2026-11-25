# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos cluster up --k3d` and `cluster down` through the installed command, with
stand-ins for docker, kubectl, kind and k3d on a PATH of their own, so no cluster is
made or deleted."""

from __future__ import annotations

import subprocess

from .harness import CliCase


def _said(result: subprocess.CompletedProcess[str]) -> str:
    return " ".join((result.stdout + result.stderr).split())


def _tools(case: CliCase, scripts: dict[str, str]) -> dict[str, str]:
    """A PATH holding only `scripts`, each a shell script by its tool's name, which log
    their arguments to calls.log."""
    bin_dir = case.root / "tools"
    bin_dir.mkdir(exist_ok=True)
    for name, body in scripts.items():
        tool = bin_dir / name
        tool.write_text(f'#!/bin/sh\necho "{name} $*" >> {bin_dir}/calls.log\n{body}\n')
        tool.chmod(0o755)
    return {"PATH": f"{bin_dir}:/usr/bin:/bin"}


def _calls(case: CliCase) -> str:
    log = case.root / "tools" / "calls.log"
    return log.read_text() if log.exists() else ""


def test_cluster_up_k3d_without_k3d_says_how_to_install_it(cli_case: CliCase):
    env = _tools(cli_case, {"docker": "exit 0", "kubectl": "exit 0"})

    result = cli_case.run_cli(["cluster", "up", "--k3d"], env=env, timeout=60)

    assert result.returncode != 0, _said(result)
    assert "k3d is needed" in _said(result)
    assert "brew install k3d" in _said(result)
    assert "kind is needed" not in _said(result)


def test_cluster_up_k3d_refuses_while_a_kind_cluster_is_there(cli_case: CliCase):
    env = _tools(
        cli_case,
        {
            "kind": 'if [ "$1 $2" = "get clusters" ]; then echo canyonos; fi',
            "k3d": "exit 0",
            "docker": "exit 0",
            "kubectl": "exit 0",
        },
    )

    result = cli_case.run_cli(["cluster", "up", "--k3d"], env=env, timeout=60)

    assert result.returncode != 0, _said(result)
    assert "A kind cluster canyonos is already here" in _said(result)
    assert "k3d cluster create" not in _calls(cli_case)


def test_cluster_down_deletes_a_k3d_cluster(cli_case: CliCase):
    env = _tools(
        cli_case,
        {
            "k3d": 'if [ "$1 $2" = "cluster list" ]; then echo \'[{"name": "canyonos"}]\'; fi',
            "docker": "exit 0",
            "kubectl": "exit 0",
        },
    )

    result = cli_case.run_cli(["cluster", "down"], env=env, timeout=60)

    assert result.returncode == 0, _said(result)
    assert "Deleted the k3d cluster canyonos" in _said(result)
    assert "k3d cluster delete canyonos" in _calls(cli_case)


def test_cluster_up_names_the_container_on_the_registry_port(cli_case: CliCase):
    env = _tools(
        cli_case,
        {
            "docker": 'case "$1" in ps) echo k3d-canyonos-registry;; '
            "info) echo '8 17179869184';; inspect) exit 1;; *) exit 0;; esac",
            "kind": 'if [ "$1 $2" = "get clusters" ]; then exit 0; fi',
            "kubectl": "exit 0",
        },
    )

    result = cli_case.run_cli(["cluster", "up"], env=env, timeout=60)

    assert result.returncode != 0, _said(result)
    assert "taken by the container k3d-canyonos-registry" in _said(result)
    assert "cluster up --k3d" in _said(result)


def test_cluster_up_k3d_signs_in_with_a_token_and_makes_the_local_namespace(
    cli_case: CliCase,
):
    """On a k3d cluster that's already there (as the platform's local stack makes it),
    `cluster up --k3d` has the context sign in with a token, which canyonos can send,
    and makes the namespace `deploy --target kubernetes` deploys to by default: the
    cluster's CanyonOS API doesn't make a missing one."""
    applied = cli_case.root / "tools" / "applied.yaml"
    env = _tools(
        cli_case,
        {
            "docker": 'case "$*" in *NetworkSettings*) echo "{\\"k3d-canyonos\\": {}}";; '
            "inspect*) echo true;; info*) echo '8 17179869184';; *) exit 0;; esac",
            "k3d": 'case "$1 $2" in '
            '"cluster list") echo \'[{"name": "canyonos"}]\';; '
            "\"node list\") echo '[]';; "
            '"kubeconfig get") printf \'clusters:\\n- name: k3d-canyonos\\n'
            "  cluster: {server: 'https://0.0.0.0:6443'}\\n';; "
            "*) exit 0;; esac",
            "kubectl": 'case "$*" in *"create token"*) echo e2e-token;; '
            f'*"apply -f -"*) cat >> {applied}; echo ---  >> {applied};; '
            "*) exit 0;; esac",
        },
    )

    result = cli_case.run_cli(["cluster", "up", "--k3d"], env=env, timeout=120)

    assert result.returncode == 0, _said(result)
    calls = _calls(cli_case)
    assert (
        "kubectl --context k3d-canyonos -n kube-system create token canyonos-admin"
        in calls
    ), calls
    assert (
        "kubectl --context k3d-canyonos config set-credentials admin@k3d-canyonos "
        "--token=e2e-token" in calls
    ), calls
    manifests = applied.read_text()
    assert "kind: Namespace" in manifests and "name: canyonos-local-dev" in manifests, (
        manifests
    )


def test_cluster_up_k3d_waits_for_k3s_to_make_metrics_server(cli_case: CliCase):
    """k3s makes metrics-server a little after its nodes are Ready: `cluster up --k3d`
    waits for it to be there before waiting for it to roll out, rather than failing on
    a deployment not made yet."""
    seen = cli_case.root / "tools" / "seen"
    env = _tools(
        cli_case,
        {
            "docker": 'case "$*" in *NetworkSettings*) echo "{\\"k3d-canyonos\\": {}}";; '
            "inspect*) echo true;; info*) echo '8 17179869184';; *) exit 0;; esac",
            "k3d": 'case "$1 $2" in '
            '"cluster list") echo \'[{"name": "canyonos"}]\';; '
            "\"node list\") echo '[]';; "
            '"kubeconfig get") printf \'clusters:\\n- name: k3d-canyonos\\n'
            "  cluster: {server: 'https://0.0.0.0:6443'}\\n';; "
            "*) exit 0;; esac",
            # metrics-server is there from the third look on.
            "kubectl": f'case "$*" in *"create token"*) echo e2e-token;; '
            f'*"get deployment/metrics-server"*) echo x >> {seen}; '
            f'[ "$(wc -l < {seen})" -ge 3 ] || exit 1;; '
            f'*"rollout status deployment/metrics-server"*) '
            f'[ "$(wc -l < {seen} 2>/dev/null || echo 0)" -ge 3 ] || '
            '{ echo \'Error from server (NotFound): deployments.apps "metrics-server" '
            "not found' >&2; exit 1; };; "
            "*) exit 0;; esac",
        },
    )

    result = cli_case.run_cli(["cluster", "up", "--k3d"], env=env, timeout=120)

    assert result.returncode == 0, _said(result)
    assert seen.read_text().count("x") == 3, _calls(cli_case)
