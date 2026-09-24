# Reconciler — Architecture

Desired replica counts live durably in Redis. A separate, GlobalController-supervised
process converges running instances onto them and replaces instances that stop answering.
Scaling and replacement are Redis writes plus a wake signal — no caller waits on Docker or
EC2. The code is the source of truth; this covers only what it cannot tell you.

## How it works

**Level-triggered.** Every pass recomputes what should exist (desired counts in Redis) and
what does exist (`agent_instance:*` hashes) and acts on the difference. Nothing is derived
from the event that woke the loop, so a lost signal, a Redis blip or a crash mid-pass
costs latency, never correctness. The periodic `sweep_interval` exists so the system
converges even when every signal is lost.

**The queue carries wake signals only** — an agent name or `"*"`, never "add 2". The count
is already durable; a delta would be a second source of truth that a re-delivered or
dropped message would permanently skew. The queue decouples callers from provisioning
latency and serializes reconciles into one worker, so two cannot race on a slot.

**The YAML is the source of truth.** Startup and every reload write each agent's configured
`replicas` through `set_replicas`, overwriting whatever Redis holds, so a changed config
always takes effect. A runtime `set_replicas` holds only until the next reload or redeploy.
Each pass removes, then fills.

The removal rule is on the **index**, not "remove the last N": that makes scale-down
deterministic and idempotent (5→2 always removes 2, 3, 4) and removes orphans a count-based
rule cannot see, since `ensure_instances` only looks at `range(0, desired)`. Replacement
needs no code of its own — `ensure_instances` is create-only and per-slot idempotent, so
removing index 1 leaves a hole the same pass's fill step provisions into.

## Redis schema

| Key | Type | Written by | Read by |
| --- | --- | --- | --- |
| `agent:{name}:desired_replicas` | int (string) | GlobalController — `set_replicas` (also from `_apply_configured_replicas`) | Reconciler (`get_desired`, `desired_agent_specs`) |
| `reconciler:wake` | list | GlobalController — `_request_reconcile` | Reconciler (`drain`: `BRPOP` then non-blocking `RPOP`s) |
| `reconciler:replace` | set | GlobalController — `replace_replica` | Reconciler (`replace_requests`; `clear_replace_requests` once removed) |
| `reconciler:draining` | string (TTL) | GlobalController — `set_draining` / `clear_draining` | Reconciler (`is_draining`, once per pass) |
| `agent:{name}:spec` | string (JSON) | GlobalController — `write_config_specs` | Reconciler (`read_config_specs`) |
| `agents:active` | string (JSON list) | GlobalController — `write_config_specs`, written after the specs | Reconciler (`read_config_specs`, read **first**) |
| `agent:{name}:instances` | set | `Provisioner` | both |
| `agent_instance:{provider}:{name}:{index}` | hash | `Provisioner` | both |
| `routing_table:services` / `:endpoints` / `:stateful` | set / hash / hash | `publish_routing_snapshot` | routing clients |
| `controller:{host}:{port}:metrics` | hash | the agent's `LocalController` | GlobalController poll; reconciler freshness check |
| `controller:{host}:{port}:status` | string | the agent's `LocalController` | GlobalController only — deliberately not a health signal |

The first five are owned here; the rest is pre-existing observed state this reads. Desired
state and records live on the **primary** client (`context.redis`); `controller:*` metrics
live on the node's own Redis, via `node_redis_for_instance`.

## Process layout

A separate OS process, not a thread: provisioning is slow, blocking and failure-prone
(Docker, SSH, EC2) and must not stall GlobalController's health polling — the loop that
decides an instance is unhealthy. `ProcessSupervisor` spawns it in `__init__`, respawns it
from the poll tick, stops it from `stop()`. The child is `sys.executable -m
canyonos_core.reconciler --config <abspath>`, absolutized at registration because it
inherits the parent's cwd. `check_and_respawn` is guarded by `if self.running:`, or a
SIGTERM landing mid-tick would resurrect the process shutdown just killed.

**The import boundary is a hard requirement.** `global_controller.py` does
`sys.path.insert(0, os.path.abspath("grpc_stubs"))` at module level, resolved against the
cwd, so it imports only from a project root with generated stubs — a child process must
never import it. The slice provisioning needs is `ControllerContext`, which
GlobalController subclasses and the reconciler constructs directly; cluster bootstrap
(cleanup, launching Redis, policies, identity) stays the controller's.

The write side (`provisioner.py`, `providers/`, `routing.py`) lives under `reconciler/`, and
the record readers are plain functions in `controller_context.py`, so **the controller
cannot create or destroy a container because it does not import the code that can**.
`routing_endpoint_for` is derived from the record rather than the provider module, or the
controller would import provisioning code to format an endpoint.

## Traps

**The fill step must pass the full spec list** for every configured agent with desired counts
substituted in — never one agent's. That is what `desired_agent_specs` is for.
`publish_routing_snapshot` treats the list it is given as the complete world, `srem`/`hdel`
-ing every service absent from it, so `ensure_instances([one_spec])` would delete every
*other* agent from the routing table — all still running, now unreachable until the next
full pass. `remove_instance` has the same exposure and republishes from the last list it
was handed, falling back to `controller.controllers`.

**Resolve node Redis clients from the instance record.** `node_redis` is populated as a
side effect of provisioning, so an instance created by the *other* process is registered
only there. `node_redis_for_instance(instance)` connects on demand from the record's own
`host`/`redis_port`. The host-keyed accessor it replaced fell back to `self.redis` on a
miss, which would have the reconciler read a local key, call a remote instance's metrics
stale, and remove every remote replica on the first pass.

**`attach_local_node_redis()` must run in the reconciler's `__init__`.** GlobalController
repoints its primary `self.redis` at the local node's Redis after launching that container;
a process that only attaches must repoint too, or the two write to different Redises — the
reconciler sees zero instances, provisions a duplicate fleet, never converges.

## Health and liveness

`controller:{host}:{port}:status` **cannot express "dead"**. The agent's own
`LocalController` writes `"healthy"` at init and every metrics interval, and `"stopped"`
only on a graceful shutdown that by definition does not run when a container is killed,
OOMs or hangs. No TTL, so a dead replica reads `healthy` forever — hence direct probes.
`_is_healthy` needs two independent positives, a TCP connect and a fresh metrics hash.
Neither suffices alone: a gRPC server can accept connections while the agent behind it is
wedged, and a stale hash cannot tell "wedged" from "never there".

**A Redis read failure is deliberately not unhealthy** — `_reports_are_fresh` returns
`True` if `hgetall` raises. An outage is evidence about the reconciler's connectivity, not
the instance; treating it as unhealthy turns one hiccup into a fleet-wide rebuild. A
*missing* hash is a real negative.

**Startup grace, but no debounce.** An instance that has never reported is starting, so
`max(30, 3 * poll_interval)` seconds from `created_at` are forgiven — and only until it is
first seen healthy, after which it is judged on live probes alone. Without this the loop
provisions a container, probes it while it is still booting, destroys it, and provisions
another, forever. Going down there is no debounce: replacement is cheap, downtime is not.

## Teardown

Teardown converges through the loop rather than tearing the fleet down underneath the
process whose job is to rebuild it. **Why a flag, not desired counts:** deleting the
keys does not drain, since `_remove_unwanted` and `desired_agent_specs` fall back to the YAML count;
setting them to 0 does drain, but a zero never expires, and only an expiring flag lets an
orphaned reconciler recover. **Why the TTL:** a SIGKILLed controller orphans its child, and a permanent
flag would have it hold the fleet at zero forever. `__init__` clears the flag before
starting the reconciler, so one stranded by a mid-drain kill cannot poison the next run.

`stop()` orders four load-bearing steps: drain, then `terminate_all()` (the reconciler is
what removes instances), then `clear_draining()` (or the live reconciler refills), then
`_stop_redis_containers()` last, since the reconciler needs Redis to remove instances.

Nothing sweeps at startup, deliberately: the first full `reconcile()` removes a leftover
record whose container is gone (probe fails, `created_at` is old so no grace) and refills
the slot in the same pass, while a still-healthy leftover is reused — which an
unconditional sweep would destroy.

## Config and spec handoff

`ControllerContext._load_config` resolves the config for **both** processes: load
`<project>/.env`, `yaml.safe_load`, expand `${VAR}`. Both must load through it or they
disagree about the same file — and since provisioning moved here, the unexpanded copy is
the one reaching the provider runtimes, where an `ec2:` block declared with `${EC2_AMI_ID}`
would hit the AWS API verbatim. An unset ref expands to itself, so a missing variable is a
visibly wrong value, not a silent default.

The `agents:` list is handed off through Redis rather than read twice: `write_config_specs`
publishes each spec as JSON then the name list **last**, and `refresh_controllers_from_redis`
adopts them every pass, so a reload needs no SIGHUP handler here. List-last makes a torn
read impossible without version numbers. The list is one JSON string replaced by a single
`SET`, and stale specs are deleted only after it stops naming them. `read_config_specs` returns
`None` (not `[]`) when the key is missing and the reader keeps its specs — `[]` would read as
"no agents configured" and remove the fleet on an unseeded Redis. An intentionally empty publish
is the string `[]`, which still exists, so it reads as `[]`. A full pass also removes instances
of any agent no longer published, and `reload_config` deletes a removed agent's
`desired_replicas` so a runtime scale does not return if the agent is re-added. Everything outside `agents:` is still
read from the YAML by both processes at construction.

## Known gaps

- **No respawn backoff or crash-loop cap in `ProcessSupervisor`.** The reconciler owns
  initial provisioning *and* routing publication, so one that dies on startup leaves the
  controller serving nothing, respawned every tick forever.
- **A list-form `replicas` is unsupported, just not silently** — `ensure_instances` raises
  `TypeError`, and `desired_agent_specs` passes the spec through rather than drop the agent
  from routing.
- **Smaller, known:** instance identity is a slot index, not a UUID; `replace_requests`
  matches by substring, so an agent name containing a colon mis-claims; a vanished node is
  removed one slot at a time as "unhealthy".
