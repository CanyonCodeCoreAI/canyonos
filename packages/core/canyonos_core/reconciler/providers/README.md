# Cloud Provider Logic

Backend implementations for where CanyonOS runs an agent's container. The top-level
`provider:` in `global_controller.yaml` picks one for the whole deployment: `local`, `ec2-pool` or `ec2-assign`.

The providers differ in where each agent container runs: local runs on the deployment host, while EC2 launches a separate EC2 machine.

## Providers

| Provider | Folder | Compute |
| --- | --- | --- |
| `local` (default) | `Local/` | Docker container on the same machine, the root README has the whole flow. |
| `ec2-pool` | `EC2/` (`_schema_pool.py`) | A pool of EC2 machines that every replica shares, listed in `ec2-pool:`. |
| `ec2-assign` | `EC2/` (`_schema_assign.py`) | An EC2 machine per replica, of the type `ec2-assign:` gives its agent. Runs on the same `_provider.py` as `ec2-pool`. |

## Interface

Callers use `providers/__init__.py`:

| Call | Returns |
| --- | --- |
| `providers.get(name)` | The provider module for a name in any casing |
| `providers.bind(controller)` | Nothing; gives every provider this process's controller. `ControllerContext` calls it when built |
| `providers.canonical_name(name)` | The name as records store it; raises `ValueError` for an unknown provider |
| `providers.NAMES` | Every provider name |
| `providers.SCHEMAS` | Each provider's schema module, by name |
| `providers.schema(name)` | A provider's schema module for a name as `get` takes it, such as one a machine record stores |
| `providers.RENAMED`, `providers.RENAMED_SECTIONS` | Old provider and section names, each with its new one, for the config check to name |

Every provider module implements:

| Function | Purpose | Called | Must |
| --- | --- | --- | --- |
| `preflight()` | Stops a deploy this machine can't run before anything is launched | Once, by `canyonos deploy` before the controller starts | Raise if this machine can't deploy with this provider. No `_controller` is bound |
| `machine_platform()` | Builds images for the platform the machines run | Once per deploy, by `canyonos deploy` | Return the Docker platform, e.g. `linux/amd64`, or `None` for this machine's own |
| `machine_capacity(machine_spec)` | Lets placement put several replicas on one machine | Before starting a machine | Return the machine's `cpu` (vCPUs) and `memory` (MiB), or `None` for no limit |
| `start_machine(machine_spec, launch_id)` | Gets the machine saved before the slow startup, so a launch that dies partway can still be found and freed | At deploy, for each machine the section declares | Start a machine of that spec, without waiting, and return a dict that is saved to its machine record right away. Make it findable by `launch_id` (EC2 sends it as the `ClientToken`) |
| `wait_for_machine(machine)` | Gets the machine ready for `replicas.launch` to start the container on | Right after | Wait until it can run containers and return `private_host`, `public_host`, and optionally `user` and `container_timeout`. On failure, just raise |
| `machine_alive(machine)` | Lets a pool machine that died be replaced and its replicas relaunched elsewhere | Every reconcile pass, for each machine that came up | Return whether the machine still exists; raising skips the check for that pass |
| `terminate_machine(machine)` | Frees a machine, half-finished launches included, so nothing is left running or billing | At stop, once every replica is removed | Free it by `machine_id`, or by `launch_id` (saved with `launched_at`). Already gone is not an error; raising keeps the record for the next pass |
| `hourly_cost(machine_spec)` | Prices compute: a call's cost is this rate times how long the call ran | Before each launch | Return the USD per hour of one machine of that spec |

`machine_spec` is one machine type from the provider's section (`MACHINE_TYPES`) plus the keys
every machine shares (`MACHINE_KEYS`).

A replica's record has `agent_name`, `provider`, `replica_id`, `private_host`,
`public_host`, `host_port`, `container_port`, `published_address`, `address`, `redis_host`,
`redis_port`, `container_name`, `machine`, `cpu` and `memory`, and optionally `user`. Its
machine's record, `machine_record:<machine>`, holds its `machine_spec`, its capacity and what
`start_machine` and `wait_for_machine` return. Every machine is started at deploy. Placement
puts a replica on the least loaded one, the larger of its CPU and memory fill, and never
refuses: a full pool is shared. The replica's price is the
machine's hourly cost times its share of the machine's vCPUs.
`replicas.launch` starts the container on the machine and builds the replica's record.
Removing a replica drains it and removes only its container. A machine goes when it dies,
when the config drops it, or at stop.

`published_address` is the replica's published `host:port`. Only a replica that callers on
other machines reach is published: one on another machine, the endpoint when the
deployment's provider isn't `local` (its agents call it back at `CANYONOS_PRIVATE_IP`), and
a database on its `db_port`. Any other replica on the
Global Controller's machine publishes nothing, so its `host_port` is its container port
and its `published_address` is its `address`, as a pod's is on Kubernetes.

`address` is the `host:port` other agents and the controllers reach it on: for an agent or
the endpoint, the address the container is given as `CANYONOS_AGENT_HOST` and
`CANYONOS_AGENT_PORT`; for a database, the port the database listens on. The routing table
lists it, and the replica's status, metrics and agent id keys in Redis are named after it. A
record counts as finished once it has `address`.

`providers.bind` sets each module's `_controller`. A provider reads the deploy config from
`_controller.config` and runs commands on a host with `_controller._run_cmd(cmd, host, user)`.

Every provider also has a schema module (`_schema.py`; ec2-pool's is `_schema_pool.py`
and ec2-assign's `_schema_assign.py`, as they share the `EC2/` package), which the manifest schema checks
`global_controller.yaml` against. It must not import `_provider.py`, since the CLI reads it:

| Name | Holds |
| --- | --- |
| `SECTION` | The provider's top-level section name, or `None`. Required when it is the deployment's `provider` |
| `SECTION_KEYS` | That section's keys |
| `RETIRED_KEYS` | Keys the section no longer takes, each with the message saying what to do instead |
| `MACHINE_TYPES` | The section key mapping each machine type to how many to start, or `None` for this machine only |
| `MACHINE_KEYS` | The section's keys every machine shares, added to each type's `machine_spec` |
| `MACHINE_PER_REPLICA` | The section key mapping each agent to its machine type, for a machine per replica, or `None`. Each such machine's `machine_spec` also has `agent_name`, and it takes one replica of that agent: a replica whose machine fails to start waits for the replacement |

Each key maps to `(type, required)`, where type is `str`, `list` (of strings), `int` (at
least 1), `"port"` (1 to 65535), `dict` (names to counts of at least 1) or `"agents"` (every agent's name to a string, and no other names). The schema only checks keys; defaults live in `_provider.py`,
which reads the raw config.

To add a provider: create a folder with a `_provider.py` implementing the functions above
and a `_schema.py`, add its package path and schema module to `_PACKAGES` in
`providers/__init__.py`, and add a row to the Providers table.

## Keep provider code here

This folder owns everything that depends on which provider a replica's machine comes from: how the machine is started, waited for, freed and priced, its SSH user, and its config keys and defaults. Running the container is the same for every provider and lives in `reconciler/replicas.py`. The rest of CanyonOS (the machine and replica provisioners, reconciler, Global Controller, CLI, manifest schema and server) does not know which provider it is talking to, and reaches one only through `providers/__init__.py`.

When you change provider behaviour:

- Outside this folder, don't import `Local/` or `EC2/` code, compare a provider's name, or read a provider's config keys.
- If a caller needs a provider-specific answer, add a function to the interface below and implement it in every provider. Don't branch on the provider in the caller.
- Adding a provider should only touch this folder.
