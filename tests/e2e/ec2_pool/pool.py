# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The checks tests/e2e/ec2_pool.sh runs against a deploy's Redis, its machines' Redis
and AWS. Each command exits non-zero with the reason when its check fails.

Usage: pool.py <command> [arguments]
"""

import json
import os
import subprocess
import sys
import time
import urllib.request

import boto3
import redis

from canyonos_core.llm_gateway.pricing import machine_hourly_cost

ENDPOINT = "http://127.0.0.1:8090"
# The fixture's pool and what AWS lists for each type.
POOL = {"t3.micro": 2, "t3.small": 1}
CAPACITY = {"t3.micro": ("2", "1024"), "t3.small": ("2", "2048")}

controller_redis = redis.Redis(port=6390, decode_responses=True)
ec2 = boto3.client("ec2", region_name=os.environ["EC2_REGION"])


def check(condition, message):
    if not condition:
        sys.exit(f"FAIL: {message}")


def replica(replica_id):
    return controller_redis.hgetall(f"agent_instance:{replica_id}")


def replicas():
    return {
        key.removeprefix("agent_instance:"): controller_redis.hgetall(key)
        for key in controller_redis.scan_iter("agent_instance:*")
    }


def replicas_of(agent_name):
    return {
        replica_id: record
        for replica_id, record in replicas().items()
        if record.get("agent_name") == agent_name
    }


def machines():
    """The EC2 machines of the pool, by launch id."""
    found = (
        controller_redis.hgetall(key)
        for key in controller_redis.scan_iter("machine_record:*")
    )
    return {m["launch_id"]: m for m in found if m["provider"] == "EC2"}


def wait(condition, timeout, message):
    deadline = time.monotonic() + float(timeout)
    while not condition():
        check(time.monotonic() < deadline, message)
        time.sleep(5)


def check_pool():
    """Every machine of the pool started at deploy, sized and sharing market_type."""
    pool = machines()
    types = [m["machine_type"] for m in pool.values()]
    check(sorted(types) == sorted(t for t, n in POOL.items() for _ in range(n)), types)
    for m in pool.values():
        check(m.get("private_host"), f"machine {m['launch_id']} never came up")
        check((m["cpu"], m["memory"]) == CAPACITY[m["machine_type"]], m)
        check(m.get("market_type") == "on-demand", m)
        (found,) = ec2.describe_instances(InstanceIds=[m["machine_id"]])[
            "Reservations"
        ][0]["Instances"]
        check(found["InstanceType"] == m["machine_type"], found["InstanceType"])
    print(json.dumps({m["private_host"]: m["machine_type"] for m in pool.values()}))


def check_placement():
    """Workflow alone, Small with SlowAgent because Big's machine has more memory in
    use, the endpoint on this machine, and each replica priced by its CPU share."""
    on = {record["agent_name"]: record.get("machine") for record in replicas().values()}
    check(list(on.values()).count(on["Workflow"]) == 1, f"Workflow shares: {on}")
    check(on["Small"] == on["SlowAgent"], f"Small is not with SlowAgent: {on}")
    check(on["Big"] not in (on["SlowAgent"], on["Workflow"]), on)
    (endpoint,) = replicas_of("endpoint").values()
    check(endpoint["private_host"] == "localhost", "endpoint moved")
    pool = machines()
    for replica_id, record in replicas().items():
        if record["agent_name"] == "endpoint":
            continue
        machine = pool[record["machine"]]
        price = redis.Redis(host=record["private_host"], decode_responses=True).get(
            f"agent:{replica_id}:hourly_cost"
        )
        share = float(record["cpu"]) / float(machine["cpu"])
        expected = machine_hourly_cost(machine["machine_type"]) * share
        check(
            abs(float(price) - expected) < 1e-9, f"{replica_id}: {price} != {expected}"
        )


def kill(agent_name):
    """Terminate the machine an agent's one replica runs on, as a spot reclaim would."""
    (record,) = replicas_of(agent_name).values()
    machine = machines()[record["machine"]]
    ec2.terminate_instances(InstanceIds=[machine["machine_id"]])
    print(machine["private_host"])


def replaced(dead_host, timeout):
    """The dead machine is forgotten, the pool is whole again, and every replica is
    running somewhere else."""

    def whole():
        pool = machines()
        up = [m for m in pool.values() if m.get("private_host")]
        return (
            len(up) == sum(POOL.values())
            and dead_host not in (m["private_host"] for m in up)
            and all(
                record.get("address") and record.get("private_host") != dead_host
                for record in replicas().values()
            )
            and len(replicas()) == 5
        )

    wait(whole, timeout, "the pool was not whole again with every replica relaunched")


# Run in the Global Controller container: set a machine type's count in the config the
# Global Controller runs, then reload it with SIGHUP.
RELOAD = """
import os, signal, sys, yaml
machine_type, count = sys.argv[1], int(sys.argv[2])
for pid in filter(str.isdigit, os.listdir("/proc")):
    args = open(f"/proc/{pid}/cmdline").read().split("\\0")
    if args[1:4] == ["-m", "canyonos_core.cli", "deploy"]:
        path = os.path.join(
            os.readlink(f"/proc/{pid}/cwd"), "config", "global_controller.yaml"
        )
        config = yaml.safe_load(open(path))
        config["ec2"]["machine_type"][machine_type] = count
        yaml.safe_dump(config, open(path, "w"), sort_keys=False)
        os.kill(int(pid), signal.SIGHUP)
"""


def shrink(machine_type, timeout):
    """Reload the config with one machine fewer of a type: the newest is terminated and
    forgotten, none is started, and every replica runs again on the machines kept."""
    pool = machines()
    newest = max(
        (m for m in pool.values() if m["machine_type"] == machine_type),
        key=lambda m: float(m["launched_at"]),
    )
    count = len(replicas())
    (gc,) = subprocess.run(
        ["docker", "ps", "-q", "--filter", "label=canyonos.role=global-controller"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()
    subprocess.run(
        ["docker", "exec", gc, "python", "-c", RELOAD, machine_type]
        + [str(POOL[machine_type] - 1)],
        check=True,
    )

    def shrunk():
        return (
            machines().keys() == pool.keys() - {newest["launch_id"]}
            and len(replicas()) == count
            and all(
                record.get("address") and record.get("machine") != newest["launch_id"]
                for record in replicas().values()
            )
        )

    wait(shrunk, timeout, "the dropped machine was not replaced by the machines kept")
    (found,) = ec2.describe_instances(InstanceIds=[newest["machine_id"]])[
        "Reservations"
    ][0]["Instances"]
    check(found["State"]["Name"] in ("shutting-down", "terminated"), found["State"])
    print(newest["private_host"])


def call(seconds):
    request = urllib.request.Request(
        f"{ENDPOINT}/main",
        data=json.dumps({"seconds": seconds}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        print(json.loads(response.read())["request_id"])


def status(request_id, timeout, expected):
    """Wait for a request to end, and check how it ended."""
    ended = {}

    def done():
        with urllib.request.urlopen(f"{ENDPOINT}/status/{request_id}") as response:
            ended.update(json.loads(response.read()))
        return ended["status"] in ("done", "error")

    wait(done, timeout, f"request {request_id} did not end within {timeout}s")
    check(ended["status"] == expected, ended)
    print(ended.get("error") or ended.get("result"))


def scale(agent_name, count):
    controller_redis.set(f"agent:{agent_name}:desired_replicas", count)
    controller_redis.lpush("reconciler:wake", agent_name)


def load(machine_id, pool):
    """A machine's load: the larger of its CPU and memory fill."""
    on = [r for r in replicas().values() if r.get("machine") == machine_id]
    return max(
        sum(float(r["cpu"]) for r in on) / float(pool[machine_id]["cpu"]),
        sum(float(r["memory"]) for r in on) / float(pool[machine_id]["memory"]),
    )


def scale_up(agent_name, count, timeout):
    """Scale up by one: the new replica lands on the least loaded machine, and no
    machine is started."""
    pool = machines()
    loads = {machine_id: load(machine_id, pool) for machine_id in pool}
    least = {m for m, value in loads.items() if value == min(loads.values())}
    before = replicas_of(agent_name).keys()
    scale(agent_name, count)

    def started():
        return [
            record
            for replica_id, record in replicas_of(agent_name).items()
            if replica_id not in before and record.get("address")
        ]

    wait(started, timeout, f"no new {agent_name} replica started")
    (new,) = started()
    check(new["machine"] in least, f"{new} not on the least loaded {loads}")
    check(machines().keys() == pool.keys(), "a machine was started or lost")


def drain_overlap(agent_name, timeout):
    """Scale an agent's one replica, busy with a call, to 0 and back to 1: its
    replacement starts while it still drains, instead of after its drain ends."""
    ((old, record),) = replicas_of(agent_name).items()
    machine_redis = redis.Redis(
        host=record["private_host"], port=record["redis_port"], decode_responses=True
    )

    def busy():
        metrics = machine_redis.hgetall(f"controller:{record['address']}:metrics")
        # Served counts calls started, completed those finished.
        return int(metrics.get("requests_served", 0)) > int(
            metrics.get("requests_completed", 0)
        )

    # An idle replica drains at once, which would leave nothing to overlap with.
    wait(busy, timeout, f"{old} never started the call")
    scale(agent_name, 0)
    wait(lambda: "draining_at" in replica(old), timeout, f"{old} never drained")
    scale(agent_name, 1)
    wait(
        lambda: replicas_of(agent_name).keys() - {old},
        timeout,
        f"no replacement for {old} started",
    )
    check("draining_at" in replica(old), f"{old} was gone before its replacement")
    wait(lambda: not replica(old), timeout, f"{old} never finished draining")
    wait(
        lambda: all(r.get("address") for r in replicas_of(agent_name).values()),
        timeout,
        f"the replacement for {old} never started",
    )


def oversubscribe(agent_name, count, timeout):
    """More replicas than the pool's CPU: every one still starts, on the same machines."""
    pool = machines()
    scale(agent_name, count)
    wait(
        lambda: (
            sum(1 for r in replicas_of(agent_name).values() if r.get("address"))
            == int(count)
        ),
        timeout,
        f"not every {agent_name} replica started",
    )
    cpu = sum(float(r["cpu"]) for r in replicas().values() if r.get("machine") in pool)
    check(cpu > sum(float(m["cpu"]) for m in pool.values()), "the pool was not full")
    check(machines().keys() == pool.keys(), "a machine was started or lost")


def instances(start, count, *states):
    """The machines this run launched: how many, and that every one is in `states`."""
    found = [
        instance
        for page in ec2.get_paginator("describe_instances").paginate(
            Filters=[{"Name": "tag:Name", "Values": ["canyonos-*"]}]
        )
        for reservation in page["Reservations"]
        for instance in reservation["Instances"]
        if instance["LaunchTime"].strftime("%Y-%m-%dT%H:%M:%SZ") >= start
    ]
    by_state = {}
    for instance in found:
        by_state.setdefault(instance["State"]["Name"], []).append(
            instance["InstanceId"]
        )
    check(
        count == "any" or len(found) == int(count), f"{len(found)} launched: {by_state}"
    )
    check(set(by_state) <= set(states), by_state)
    print(json.dumps(by_state))


COMMANDS = {
    "check-pool": check_pool,
    "check-placement": check_placement,
    "kill": kill,
    "replaced": replaced,
    "call": call,
    "status": status,
    "shrink": shrink,
    "scale-up": scale_up,
    "drain-overlap": drain_overlap,
    "oversubscribe": oversubscribe,
    "instances": instances,
}

if __name__ == "__main__":
    COMMANDS[sys.argv[1]](*sys.argv[2:])
