# Cloud Provider Logic

Backend implementations for where CanyonOS runs an agent's container. Every agent
in `global_controller.yaml` picks one via `provider: local` or `provider: EC2`.

The providers differ in where each agent container runs: local runs on the deployment host, while EC2 launches a separate EC2 instance.

## Providers

| Provider | Folder | Compute |
| --- | --- | --- |
| `local` (default) | `Local/` | Docker container on the same machine, the root README has the whole flow. |
| `EC2` | `EC2/` | One EC2 instance per replica. |

## Interface

Callers use `providers/__init__.py`:

| Call | Returns |
| --- | --- |
| `providers.get(name)` | The provider module for a name in any casing |
| `providers.bind(controller)` | Nothing; gives every provider this process's controller. `ControllerContext` calls it when built |
| `providers.canonical_name(name)` | The name as records store it, or `None` for an unknown provider |
| `providers.NAMES` | Every provider name |
| `providers.SCHEMAS` | Each provider's `_schema` module, by name |

Every provider module implements:

| Function | Purpose | Called | Must |
| --- | --- | --- | --- |
| `preflight()` | Stops a deploy this machine can't run before anything is launched | Once per provider the agents use, by `canyonos deploy` before the controller starts | Raise if this machine can't deploy with this provider. No `_controller` is bound |
| `port_claim_host(spec)` | Keeps replicas that share a host off each other's ports | Before each launch | Return the host to claim a free port on, or `None` if the provider picks its own ports |
| `provision_instance(spec, replica_index, next_host_port, launch_id)` | Gets `runtime_id` saved before the slow startup, so a launch that dies partway can still be found and removed | To start a launch | Create what the replica runs on and, without waiting, return a dict with at least `runtime_id`; the dict is passed to `bootstrap_instance`. Make anything it creates findable by `launch_id` (EC2 sends it as the `ClientToken`) |
| `bootstrap_instance(provisioned, spec, replica_index, agent_id)` | Turns what was created into a running replica the controllers can route to | Right after | Wait for it, start the container, return the replica's record. On failure, just raise |
| `terminate_instance(instance)` | Frees what a replica used, half-finished launches included, so nothing is left running or billing | On removal, and for any launch that never finished | Remove it by `runtime_id`, or by `launch_id` (saved with `launched_at`) if none was saved. Already gone is not an error; raising keeps the record for the next pass |
| `is_running(instance)` | Decides whether a redeploy keeps an existing replica or replaces it | Before reusing a replica that already has a record | Return whether the replica is running. An unreachable host counts as not running |
| `log_tail(instance, lines)` | Shows in the deploy log why a replica failed to start, without SSHing in | When a replica fails to become healthy at deploy | Return its last `lines` lines of output as a list of strings. Raise `RuntimeError` with the reason if they can't be read |
| `ssh_user(entry)` | Lets shared code SSH into any provider's hosts without knowing how that provider logs in | Before SSH to an agent's or replica's host | The SSH user for an agent spec or replica record |
| `hourly_cost(spec)` | Prices compute: a call's cost is this rate times how long the call ran | Before each launch | Return the USD per hour one replica of the agent costs; it prices the replica's calls |

The record `bootstrap_instance` returns has `agent_name`, `provider`, `replica_index`,
`private_host`, `public_host`, `host_port`, `container_port`, `endpoint`,
`routing_endpoint`, `redis_host`, `redis_port` and `runtime_id`, and optionally `user`.

`endpoint` is the replica's published `host:port`. `routing_endpoint` is the `host:port`
other services and the controllers reach it on: for an agent or the endpoint, the address the
provider gives the container as `CANYONOS_AGENT_HOST` and `CANYONOS_AGENT_PORT`; for a
database, the port the database listens on. The routing table lists it,
and the replica's status, metrics and agent id keys in Redis are named after it. A record
counts as finished once it has `routing_endpoint`.

`providers.bind` sets each module's `_controller`. A provider reads the deploy config from
`_controller.config` and runs commands on a host with `_controller._run_cmd(cmd, host, user)`.

Every provider also has a `_schema.py`, which the manifest schema checks
`global_controller.yaml` against. It must not import the runtime, since the CLI reads it:

| Name | Holds |
| --- | --- |
| `SECTION` | The provider's top-level section name, or `None`. Required once an agent uses the provider |
| `SECTION_KEYS` | That section's keys |
| `RETIRED_KEYS` | Keys the section no longer takes, each with the message saying what to do instead |
| `AGENT_KEYS` | Keys any agent entry may set, required only on this provider's agents |

Each key maps to `(type, required)`, where type is `str`, `list` (of strings), `int` (at
least 1) or `"port"` (1 to 65535). The schema only checks keys; defaults live in the runtime,
which reads the raw config.

To add a provider: create a folder with a `_runtime.py` implementing the functions above
and a `_schema.py`, add its package path to `_PACKAGES` in `providers/__init__.py`, and
add a row to the Providers table.

## Keep provider code here

This folder owns everything that depends on which provider runs a replica: how it is launched, reached, checked, removed and priced, its SSH user, and its config keys and defaults. The rest of CanyonOS (the provisioner, reconciler, Global Controller, CLI, manifest schema and server) does not know which provider it is talking to, and reaches one only through `providers/__init__.py`.

When you change provider behaviour:

- Outside this folder, don't import `Local/` or `EC2/` code, compare a provider's name, or read a provider's config keys.
- If a caller needs a provider-specific answer, add a function to the interface below and implement it in every provider. Don't branch on the provider in the caller.
- Adding a provider should only touch this folder.
