# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""A config change reaches the running deploy through `canyonos sync`, with no
redeploy: one more replica of an agent starts while the Global Controller and every
other replica keep running. An agent whose new replica cannot start is named in
`canyonos status` with the reason, its last launch error.
`canyonos test` queries the running deploy while it holds the project's current
files, a sync included, and refuses it once the config or the code changed. Each
case puts the config back as it was, comments and all, and syncs it."""

import contextlib
import re

import pytest
import yaml

from ..fleet import agent_status, replica_containers
from ..harness import (
    as_argument,
    canyonos,
    docker,
    manifest,
    poll,
    project_containers,
    project_root,
)

SYNC_TIMEOUT = 120
# More CPUs than any machine has, so Docker refuses to start the container.
UNSCHEDULABLE_CPUS = 999


def _config(deployed):
    return project_root(deployed.dir) / "config" / "workflow_config.yaml"


def _scaled_agent(deployed):
    """The agent the cases change: one the endpoint does not serve, so queries keep
    flowing while it changes."""
    endpoint_agent = manifest(deployed.dir)["endpoint"]["agent"]
    return next(name for name in deployed.agents if name != endpoint_agent)


def _edit_agent(text, agent, *, replicas, cpu=None):
    """`text` with `agent`'s `replicas:` set, and its `resources.cpu` too when `cpu`
    is given. Comments are lost; `_synced` writes the original text back."""
    config = yaml.safe_load(text)
    spec = next(spec for spec in config["agents"] if spec["name"] == agent)
    spec["replicas"] = replicas
    if cpu is not None:
        spec.setdefault("resources", {})["cpu"] = cpu
    return yaml.safe_dump(config, sort_keys=False)


def _sync(recorder, deployed):
    canyonos(recorder, ["sync"], cwd=deployed.dir, timeout=300)


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
        for name, state in project_containers(recorder, deployed.group).items()
        if state == "running"
    )


def test_sync_scales_an_agent_without_redeploying(recorder, deployed):
    agent = _scaled_agent(deployed)
    desired, _, _ = agent_status(recorder, deployed, agent)
    before = _container_identity(recorder, _running(recorder, deployed))
    assert f"{deployed.group}-global-controller" in before, before
    edited = _edit_agent(_config(deployed).read_text(), agent, replicas=desired + 1)
    with _synced(recorder, deployed, edited):
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
            rf"{re.escape(deployed.group)}-{agent.lower()}-[0-9a-f]{{8}}", added[0]
        ), added


def test_status_names_an_agent_that_cannot_start(recorder, deployed):
    """The extra replica asks for more CPUs than the machine has, so every launch
    fails; the running replicas stay."""
    agent = _scaled_agent(deployed)
    desired, _, _ = agent_status(recorder, deployed, agent)
    edited = _edit_agent(
        _config(deployed).read_text(),
        agent,
        replicas=desired + 1,
        cpu=UNSCHEDULABLE_CPUS,
    )
    container = f"{deployed.group}-{agent.lower()}-"
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


@pytest.mark.trait("quick")
def test_canyonos_test_runs_on_a_synced_config(recorder, deployed, check):
    """`canyonos test` runs on a deploy whose config changed once `canyonos sync`
    applied it, because the sync records the new config."""
    edited = _config(deployed).read_text() + "# synced by the E2E check\n"
    query = deployed.project.cli_query or as_argument(deployed.endpoint, deployed.query)
    timeout = str(deployed.project.timeout)
    with _synced(recorder, deployed, edited):
        call = canyonos(
            recorder,
            ["test", query, "--json", "--timeout", timeout],
            cwd=deployed.dir,
            timeout=deployed.project.timeout + 120,
        )
        report = call.json()
        assert report["against_existing_deploy"] is True, call.stdout
        assert report["error"] is None, call.stdout
        problems = list(
            check.problems(
                report["result"],
                query=deployed.query,
                request_id=report["request_id"],
            )
        )
        assert not problems, "\n".join(problems)


def test_canyonos_test_refuses_a_deploy_older_than_the_files(recorder, deployed):
    root = project_root(deployed.dir)
    with (root / "config" / "workflow_config.yaml").open("a") as config:
        config.write("# edited\n")
    stale_config = canyonos(recorder, ["test", "--json"], cwd=deployed.dir, check=False)
    assert stale_config.code != 0, stale_config.output
    assert "Files in config/ changed" in stale_config.stdout, stale_config.stdout

    endpoint_agent = manifest(deployed.dir)["endpoint"]["agent"]
    entrypoint = next(
        spec["entrypoint"]
        for spec in manifest(deployed.dir)["agents"]
        if spec["name"] == endpoint_agent
    )
    with (root / entrypoint).open("a") as code:
        code.write("# edited\n")
    stale_code = canyonos(recorder, ["test", "--json"], cwd=deployed.dir, check=False)
    assert stale_code.code != 0, stale_code.output
    assert "Files outside config/ changed" in stale_code.stdout, stale_code.stdout
