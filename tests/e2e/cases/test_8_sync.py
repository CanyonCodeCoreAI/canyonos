# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""A config change reaches the running deploy through `canyonos sync`, which reports
the reload applied, with no redeploy: one more replica of an agent starts while the Global Controller and every
other replica keep running. An agent whose new replica cannot start is named in
`canyonos status` with the reason, its last launch error. `sync --json` names every
problem with a config the deploy rejects. `canyonos test` queries the deploy a sync
changed. Each case puts the config back as it was, comments and all, and syncs it."""

import contextlib
import re

import pytest
import yaml

from ..fleet import agent_status, replica_containers
from ..harness import (
    as_argument,
    canyonos,
    docker,
    docker_name,
    manifest,
    poll,
    workflow_group_containers,
    workflow_root,
    qualified,
)

pytestmark = pytest.mark.trait("lifecycle")

SYNC_TIMEOUT = 120
# More CPUs than any machine has, so Docker refuses to start the container.
UNSCHEDULABLE_CPUS = 999


def _config(deployed):
    return workflow_root(deployed.workflow_dir) / "config" / "workflow_config.yaml"


def _scaled_agent(deployed):
    """The agent the cases change, `<workflow>.<agent>`: one no route of the endpoint
    serves, so queries keep flowing while it changes."""
    routes = manifest(deployed.workflow_dir)["endpoint"]["routes"]
    served = {qualified(deployed.workflow_dir, route["agent"]) for route in routes}
    return next(name for name in deployed.agents if name not in served)


def _edit_agent(deployed, text, agent, *, replicas, cpu=None):
    """`text` with `agent`'s `replicas:` set, and its `resources.cpu` too when `cpu`
    is given. Comments are lost; `_synced` writes the original text back."""
    config = yaml.safe_load(text)
    spec = next(
        spec
        for spec in config["agents"]
        if qualified(deployed.workflow_dir, spec["name"]) == agent
    )
    spec["replicas"] = replicas
    if cpu is not None:
        spec.setdefault("resources", {})["cpu"] = cpu
    return yaml.safe_dump(config, sort_keys=False)


def _sync(recorder, deployed, action="reload"):
    call = canyonos(
        recorder,
        ["sync", str(deployed.workflow_dir), "--json"],
        cwd=deployed.dir,
        timeout=300,
    )
    expected = {"ok": True, "code": None, "errors": [], "action": action}
    assert call.json() == expected, call.stdout


@contextlib.contextmanager
def _synced(recorder, deployed, edited):
    """Sync `edited` as the config; afterwards sync the original back and wait until
    every agent runs its starting replicas again with no extra container left."""
    path = _config(deployed)
    original = path.read_text()
    starting = {a: agent_status(recorder, deployed, a)[0] for a in deployed.agents}
    path.write_text(edited)
    try:
        _sync(recorder, deployed)
        yield
    finally:
        path.write_text(original)
        _sync(recorder, deployed)
        for agent, count in starting.items():
            poll(
                lambda: (
                    agent_status(recorder, deployed, agent)[:2] == (count, count)
                    and len(replica_containers(recorder, deployed, agent)) == count
                ),
                timeout=SYNC_TIMEOUT,
                what=f"{agent} back at {count} replicas",
            )


def _container_identity(recorder, names) -> dict[str, str]:
    """Each named container's Docker id and start time, which change when it is
    recreated or restarted."""
    if not names:
        return {}
    listing = docker(
        recorder,
        ["inspect", "-f", "{{.Name}} {{.Id}} {{.State.StartedAt}}", *sorted(names)],
    ).output
    identity = {}
    for line in listing.splitlines():
        name, _, rest = line.strip().lstrip("/").partition(" ")
        if rest:
            identity[name] = rest
    return identity


def _running(recorder, deployed):
    return sorted(
        name
        for name, state in workflow_group_containers(recorder, deployed.group).items()
        if state == "running"
    )


def test_sync_scales_an_agent_without_redeploying(recorder, deployed):
    agent = _scaled_agent(deployed)
    desired, _, _ = agent_status(recorder, deployed, agent)
    before = _container_identity(recorder, _running(recorder, deployed))
    assert f"{deployed.group}-global-controller" in before, before
    edited = _edit_agent(
        deployed, _config(deployed).read_text(), agent, replicas=desired + 1
    )
    with _synced(recorder, deployed, edited):
        # The reload sets the count before it answers, so the status right after the sync
        # shows it; only the new replica takes a while.
        assert agent_status(recorder, deployed, agent)[0] == desired + 1
        poll(
            lambda: (
                agent_status(recorder, deployed, agent)
                == (desired + 1, desired + 1, None)
            ),
            timeout=SYNC_TIMEOUT,
            what=f"{agent} at {desired + 1} replicas after sync",
        )
        after = _container_identity(recorder, _running(recorder, deployed))
        kept = {name: after.get(name) for name in before}
        assert kept == before, f"restarted or replaced: {kept} != {before}"
        added = sorted(set(after) - set(before))
        assert len(added) == 1, added
        assert re.fullmatch(
            rf"{re.escape(deployed.group)}-{docker_name(agent)}-[0-9a-f]{{8}}", added[0]
        ), added


def test_status_names_an_agent_that_cannot_start(recorder, deployed):
    """The extra replica asks for more CPUs than the machine has, so every launch
    fails; the running replicas stay."""
    agent = _scaled_agent(deployed)
    desired, _, _ = agent_status(recorder, deployed, agent)
    edited = _edit_agent(
        deployed,
        _config(deployed).read_text(),
        agent,
        replicas=desired + 1,
        cpu=UNSCHEDULABLE_CPUS,
    )
    container = f"{deployed.group}-{docker_name(agent)}-"
    with _synced(recorder, deployed, edited):
        _, running, error = poll(
            lambda: (
                status
                if (status := agent_status(recorder, deployed, agent))[0] == desired + 1
                and status[2]
                else None
            ),
            timeout=SYNC_TIMEOUT,
            what=f"status --json to name why {agent} could not start a replica",
        )
        assert running == desired, (running, error)
        assert f"Failed to launch {container}" in error, error
        status = canyonos(recorder, ["status"], cwd=deployed.dir)
        expected = f"{agent} could not start a replica: Failed to launch {container}"
        assert expected in status.output, status.output


def test_sync_json_names_why_the_config_is_rejected(recorder, deployed):
    path = _config(deployed)
    original = path.read_text()
    path.write_text(original + "\nenv_file: .env\n")
    try:
        call = canyonos(
            recorder,
            ["sync", str(deployed.workflow_dir), "--json"],
            cwd=deployed.dir,
            timeout=300,
            check=False,
        )
    finally:
        path.write_text(original)
        # The rejected upload left the old files, so syncing them back changes nothing.
        _sync(recorder, deployed, action="none")
    assert call.code == 1, call.output
    result = call.json()
    assert result["ok"] is False and result["code"] == "workflow_invalid", call.stdout
    assert "env_file: is no longer used" in " ".join(result["errors"]), call.stdout


@pytest.mark.trait("quick")
def test_canyonos_test_runs_on_a_synced_config(recorder, deployed, check):
    """`canyonos test` queries a deploy whose config `canyonos sync` changed."""
    edited = _config(deployed).read_text() + "# synced by the E2E check\n"
    query = deployed.workflow.cli_query or as_argument(
        deployed.endpoint, deployed.query
    )
    timeout = str(deployed.workflow.timeout)
    with _synced(recorder, deployed, edited):
        call = canyonos(
            recorder,
            ["test", query, "--json", "--timeout", timeout],
            cwd=deployed.dir,
            timeout=deployed.workflow.timeout + 120,
        )
        report = call.json()
        assert report["error"] is None, call.stdout
        problems = list(
            check.problems(
                report["results"][0]["result"],
                query=deployed.query,
                request_id=report["request_id"],
            )
        )
        assert not problems, "\n".join(problems)
