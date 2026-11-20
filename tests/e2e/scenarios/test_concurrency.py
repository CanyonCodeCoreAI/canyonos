# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""How many agent calls one replica runs at once, read from its heartbeat in Redis:
memory-heavy calls lower the limit without the replica being killed, calls past the
limit wait in line and all finish, the heartbeat reports the container's memory against
its limit, and a full CPU holds new calls in line. The cases are steps on one deploy:
once one fails, the rest are skipped."""

from dataclasses import dataclass

import pytest
import redis

from ..conftest import DEPLOY_TIMEOUT
from ..fleet import routed_replicas
from ..harness import (
    Endpoint,
    canyonos,
    deployed_endpoint,
    docker,
    finished,
    poll,
    workflow_dir,
    workflow_group_redis,
    stage,
    stop_workflow_group,
    submit,
)
from ..workflows import load_workflow

pytestmark = pytest.mark.steps

# A replica's default memory limit when its agent sets no `resources:`.
MEMORY_LIMIT = 512 << 20
# The limit before the replica has learned how much memory a call takes.
CEILING = 512
CALLS = 6
# Long enough for two heartbeats to see every call running.
HOLD_SECONDS = 15
# Where the memory-heavy calls take the replica, idle memory included.
PEAK_SHARE = 0.6
REQUEST_TIMEOUT = 120
# Calls that keep the replica's one CPU busy, and for how long.
SPINNERS = 3
SPIN_SECONDS = 30
WORKFLOW = f"""\
import time


class Workflow:
    def main(self, query: str):
        if query == "spin":
            end = time.time() + {SPIN_SECONDS}
            while time.time() < end:
                pass
            return {{"mb": 0}}
        mb, seconds = map(int, query.split())
        held = b"x" * (mb << 20)
        time.sleep(seconds)
        return {{"mb": len(held) >> 20}}
"""


@dataclass(frozen=True)
class LimitedDeploy:
    endpoint: Endpoint
    store: redis.Redis
    heartbeat: str
    container: str


@pytest.fixture(scope="module")
def limited(recorder, images, tmp_path_factory):
    """helloworld with a Workflow that holds the memory and time a query asks for."""
    directory = stage(
        recorder,
        load_workflow("helloworld"),
        tmp_path_factory.mktemp("concurrency"),
        {},
    )
    folder = workflow_dir(directory)
    (folder / "agents" / "workflow.py").write_text(WORKFLOW)
    try:
        canyonos(
            recorder, ["deploy", str(folder)], cwd=directory, timeout=DEPLOY_TIMEOUT
        )
        endpoint = deployed_endpoint(recorder, directory)
        store = workflow_group_redis(recorder, directory)
        replicas = poll(
            lambda: routed_replicas(store, endpoint.agent),
            timeout=60,
            interval=1,
            what=f"a routed replica of {endpoint.agent}",
        )
        assert len(replicas) == 1, replicas
        yield LimitedDeploy(
            endpoint=endpoint,
            store=store,
            heartbeat=f"controller:{replicas[0].address}:metrics",
            container=replicas[0].container,
        )
    finally:
        stop = stop_workflow_group(recorder, directory)
        assert stop is None or stop.code == 0, stop.output[-2000:]


def _heartbeat_where(limited, test, what):
    """The first heartbeat of the replica that `test` holds for."""

    def matching():
        beat = limited.store.hgetall(limited.heartbeat)
        return beat if test(beat) else None

    return poll(matching, timeout=2 * HOLD_SECONDS, interval=0.5, what=what)


def _all_done(recorder, limited, request_ids, mb):
    for request_id in request_ids:
        status = finished(
            recorder, limited.endpoint, request_id, timeout=REQUEST_TIMEOUT
        )
        assert status == {
            "request_id": request_id,
            "status": "done",
            "result": {"mb": mb},
        }, status


def test_memory_heavy_calls_lower_the_limit(recorder, limited):
    idle = int(limited.store.hget(limited.heartbeat, "canyonos.agent.memory.used"))
    mb = int(PEAK_SHARE * MEMORY_LIMIT - idle) // CALLS >> 20
    assert mb >= 10, f"the idle replica already uses {idle} of {MEMORY_LIMIT} bytes"
    request_ids = [
        submit(recorder, limited.endpoint, f"{mb} {HOLD_SECONDS}") for _ in range(CALLS)
    ]
    _heartbeat_where(
        limited,
        lambda beat: int(beat["canyonos.agent.concurrency.limit"]) < CEILING,
        f"max_workers to drop below {CEILING} with {CALLS} calls of {mb} MB",
    )
    _all_done(recorder, limited, request_ids, mb)
    state = docker(
        recorder,
        [
            "inspect",
            "-f",
            "{{.RestartCount}} {{.State.OOMKilled}} {{.State.Status}}",
            limited.container,
        ],
    )
    assert state.output.strip() == "0 false running", state.output


def test_calls_past_the_limit_wait_and_all_finish(recorder, limited):
    limit = int(
        limited.store.hget(limited.heartbeat, "canyonos.agent.concurrency.limit")
    )
    assert limit < CEILING, limit
    # Twice the limit, so calls still wait if the limit rises while they are sent.
    request_ids = [
        submit(recorder, limited.endpoint, f"0 {HOLD_SECONDS}")
        for _ in range(2 * limit)
    ]
    beat = _heartbeat_where(
        limited,
        lambda beat: int(beat["canyonos.agent.queue.length"]) >= 1,
        f"calls waiting with {2 * limit} calls sent and max_workers {limit}",
    )
    assert int(beat["canyonos.agent.concurrency.limit"]) < CEILING, beat
    _all_done(recorder, limited, request_ids, 0)


def test_heartbeat_reports_the_container_memory(limited):
    beat = limited.store.hgetall(limited.heartbeat)
    assert int(beat["canyonos.agent.memory.limit"]) == MEMORY_LIMIT, beat
    assert 0 < int(beat["canyonos.agent.memory.used"]) < MEMORY_LIMIT, beat
    assert 1 <= int(beat["canyonos.agent.concurrency.limit"]) < CEILING, beat


def test_a_full_cpu_holds_new_calls_in_line(recorder, limited):
    spinning = [submit(recorder, limited.endpoint, "spin") for _ in range(SPINNERS)]
    _heartbeat_where(
        limited,
        lambda beat: int(beat["canyonos.agent.concurrency.limit"]) <= SPINNERS,
        f"max_workers held at the {SPINNERS} calls running while the CPU is full",
    )
    waiting = [submit(recorder, limited.endpoint, "0 5") for _ in range(SPINNERS)]
    beat = _heartbeat_where(
        limited,
        lambda beat: int(beat["canyonos.agent.queue.length"]) >= 1,
        f"calls waiting behind {SPINNERS} calls that fill the CPU",
    )
    assert int(beat["canyonos.agent.concurrency.limit"]) <= SPINNERS, beat
    # Once the spinning calls end, the CPU frees up and the held calls run.
    _all_done(recorder, limited, spinning + waiting, 0)
