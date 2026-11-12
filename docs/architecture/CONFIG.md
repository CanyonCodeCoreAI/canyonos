# Configuration

How a project's config gets from the files a user edits to the running system, and how
to add a setting. For what each setting means, see
[Workflow config](../guides/WORKFLOW_CONFIG.md).

CLI paths below are under `packages/cli/canyonos/`, and Core paths under
`packages/core/canyonos_core/`.

| Stage                                       | Code                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| [Where the files are](#where-the-files-are) | CLI `constants.py`, `sync.py`                                              |
| [Loading](#loading)                         | Core `controller/utils/config_env.py`                                      |
| [Validation](#validation)                   | Core `schema/`                                                             |
| [Applying it](#applying-it)                 | Core `controller/controller_context.py`, `controller/global_controller.py` |
| [Reloading](#reloading)                     | CLI `sync.py`, Core `server.py`                                            |

## Where the files are

The CLI reads `config/workflow_config.yaml` in the project root: `.canyon/` when the
current folder has one, else the current folder itself (`project_root` and
`default_config_path` in `constants.py`).

On Docker, `canyonos deploy` copies the project root, plus the `.env` in the folder
`canyonos` runs in, into the Global Controller container's `/workspace` with
`docker cp` (`run_sync` in `sync.py`). The container reads only that copy, so a
host-side edit reaches it only through `canyonos sync`, `canyonos config` or the next
deploy.

On Kubernetes, `canyonos deploy` uploads the project to the cluster instead. The
in-cluster build renders the config folder as a ConfigMap, plus a CanyonProject and one
CanyonAgent per agent (`kubernetes/manifests.py`). See
[Operator](OPERATOR.md).

## Loading

Every reader goes through `load_config` in `controller/utils/config_env.py`:

1. Import the project root's `.env` into the process environment, without overriding
   variables that are already set.
2. Parse the YAML.
3. Replace every `${VAR}` with the variable's text. Unset references stay as written.

Expansion is textual, so a reference always yields a string. That is why the schema
allows `${VAR}` only in string fields: a `replicas` of `"3"` would start one replica.

## Validation

`schema/` checks a project before any stub is generated. `check_project` in
`schema/__init__.py` returns the parsed manifest and every violation, and never raises.
It runs in four places:

- the in-container deploy, before anything is built (`_validate_or_exit` in `cli.py`);
- a reload, before anything changes (`POST /reload` in `server.py`, then
  `reload_config`);
- the in-cluster build on Kubernetes (`kubernetes/commands.py`);
- `canyonos validate` (Core `validate.py`), which adds the checks the schema cannot
  make.

| Module                 | What it holds                                                                    |
| ---------------------- | -------------------------------------------------------------------------------- |
| `manifest.py`          | The schema of `workflow_config.yaml`, and `load_manifest`                      |
| `functions.py`         | An agent's `functions`                                                           |
| `kubernetes_block.py`  | The `kubernetes:` section, read only by a Kubernetes deploy                      |
| `otel_destinations.py` | `otel.destinations`, shared with the exporter at runtime                         |
| `_checks.py`           | The field readers every module uses, including the `${VAR}` rule                 |
| `yaml_lines.py`        | A YAML loader that keeps line numbers, so each violation names its line          |
| `errors.py`            | `SchemaViolation` and `SchemaError`; each violation renders as one line          |
| `__init__.py`          | `check_project`, which also checks that every `entrypoint` exists in the project |

`load_manifest` parses the file into frozen dataclasses (`Manifest`, `CodeAgent`,
`DatabaseAgent`, `Resources`, `RedisSpec`, `OtelSpec`, `EndpointSpec`) and collects
every violation before raising one `SchemaError`. Function names become Python source
in the stub, so argument types are limited to builtins.

The allowed keys are declared once, at the top of `manifest.py`: top-level keys in
`_MANIFEST_KEYS`, and entry keys per type in `_AGENT_KEYS_BY_TYPE`. Anything else is
rejected. A key that no longer does anything goes in `_RETIRED_KEYS`, with the message
to show. A provider's own section (`ec2-pool:`, `ec2-assign:`) is declared in its schema
module instead; see `packages/core/canyonos_core/reconciler/providers/README.md`.

Cross-field rules live in `_agent`, `_agents`, `_endpoint` and
`_check_provider_sections`:

- A database always has one replica.
- Two agent names that differ only in case collide, since image and container names
  are lowercased. `endpoint` is reserved for the endpoint's own replica.
- The `endpoint` names an agent of type `agent` and one of its `functions`.
- The section of the deployment's `provider` must set its required keys:
  `machine_type` for both EC2 providers. In `ec2-pool:` it maps each machine type to a
  count; in `ec2-assign:` it maps each agent to a machine type.

## Applying it

`ControllerContext._load_config` (`controller/controller_context.py`) fails when the
config has no `project_id`. `canyonos deploy` adds one on the first deploy, so it stays
the same across reloads and redeploys. `GlobalController._apply_config` then publishes
the config to Redis:

| What                                                                         | Redis key                            | Written by                   |
| ---------------------------------------------------------------------------- | ------------------------------------ | ---------------------------- |
| Each agent's spec, and the list of agents                                    | `agent:{name}:spec`, `agents:active` | `write_config_specs`         |
| Desired replicas                                                             | `agent:{name}:desired_replicas`      | `_apply_configured_replicas` |
| Policy rules, most specific first, on every machine's Redis                  | `policy:rules`                       | `_write_policies`            |
| Every other YAML file in `config/`, on every machine's Redis                 | `<file>:config`, `prompts:yaml`      | `_write_policies`            |
| Governance rules from `governance.yaml`, for agents the dashboard hasn't set | `governance:config`                  | `_seed_governance`           |
| The project's identity                                                       | `controller:identity`                | `_write_identity`            |
| Where callers reach the endpoint                                             | `endpoint:address`                   | `_apply_config`              |
| OTel destinations, at startup and on reload                                  | `otel:destinations`                  | `_write_otel_destinations`   |

Each governed agent's USD spend since its `spend.since` (`governance:spend`) is not
config: the dashboard API writes it, every minute by default. Every key is listed in
[Redis keys](CONTROLLER.md#redis-keys).

On Docker and EC2, the YAML always wins: every load overwrites replica counts changed at
runtime, and the Reconciler converges running replicas onto the new desired counts (see
[Reconciler](RECONCILER.md)). On Kubernetes, the orchestrator leaves the
counts alone: each CanyonAgent already carries its configured count.

## Reloading

On Docker, `canyonos sync` and `canyonos config` apply a change to the running deploy.
`canyonos config` saves the file, then does what `canyonos sync` does
(`run_sync_and_reload` in `sync.py`):

1. Copy the project into the container, as a deploy does.
2. `POST /reload` to the container's server (`server.py`). It checks the config against
   the schema and answers `400` with every violation, changing nothing, if it finds
   one. Otherwise it sends `SIGHUP` to the Global Controller.
3. `reload_config` checks the config again and parses every config file before writing
   anything. It then republishes the config as at startup, deletes the desired count
   of any agent that was removed and wakes the Reconciler, without restarting the
   agents that remain.

A reload applies the config only: synced code changes wait for the next
`canyonos deploy`. With no deploy running, both commands say so, and the change applies
on the next deploy. A `SIGHUP` that arrives while the deploy is still starting is
ignored.

On Kubernetes, the Global Controller reloads the same way when the files of its
ConfigMap change, which `canyonos deploy` updates. See
[Config reload](CONTROLLER.md#config-reload).

## Adding a setting

1. Add the key to `_MANIFEST_KEYS` or the right agent key set in `manifest.py`, and a
   field with its default to the matching dataclass.
2. Parse it in `load_manifest` or `_agent` with the helpers in `schema/_checks.py`.
3. Read it where it's used, and publish it in `_apply_config` if other processes need
   it. On Kubernetes, the Global Controller reads the same file from the ConfigMap; a
   setting the operator acts on, such as an agent's resources, also goes into the
   CanyonProject or CanyonAgent that `kubernetes/manifests.py` renders.
4. Add an E2E schema check, and document the setting in
   [Workflow config](../guides/WORKFLOW_CONFIG.md).
