# Configuration

How a deployment's config gets from the files a user edits to the running system, and how
to add a setting. For what each setting means, see
[Workflow config](../guides/WORKFLOW_CONFIG.md).

CLI paths below are under `packages/cli/canyonos/`, and Core paths under
`packages/core/canyonos_core/`.

| Stage                                       | Code                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| [Where the files are](#where-the-files-are) | CLI `constants.py`, `sync.py`                                              |
| [Loading](#loading)                         | Core `schema/manifest.py`, `controller/utils/config_env.py`                |
| [Validation](#validation)                   | Core `schema/`                                                             |
| [Applying it](#applying-it)                 | Core `controller/controller_context.py`, `controller/global_controller.py` |
| [Reloading](#reloading)                     | CLI `sync.py`, Core `server.py`                                            |

## Where the files are

The CLI reads `deployment.yaml` in the deployment folder, the folder it runs from
(`deployment_config_path` in `constants.py`), and `config/workflow_config.yaml` in each
project folder it is given: in its `.canyon/` when it has one, else in the folder
itself (`project_folder` and `project_config_path`).

On Docker, `canyonos deploy` copies `deployment.yaml` and the `.env` beside it into the
Global Controller container's `/workspace`, and each project, with its `.env`, into
`/workspace/<project>/`, with `docker cp` (`run_sync` in `sync.py`). The container
reads only that copy, so a host-side edit reaches it only through `canyonos sync`,
`canyonos config` or the next deploy.

On Kubernetes, `canyonos deploy` uploads the project to the cluster instead. The
in-cluster build renders the config folder as a ConfigMap, plus a CanyonProject and one
CanyonAgent per agent (`kubernetes/manifests.py`). See
[Operator](OPERATOR.md). Kubernetes deploys don't support multi-folder deployments yet.

## Loading

Every reader goes through `load_deployment_config` in `schema/manifest.py`:

1. Parse `deployment.yaml` and each project's `config/workflow_config.yaml`.
2. Replace every `${VAR}` with the variable's text, from the process environment, else
   from the `.env` beside the file: the deployment folder's for `deployment.yaml`, the
   project's for its config. Unset references stay as written.
3. Name each agent `<project>.<agent>`, give each route its project, and put every
   project's agents and routes in one config.

On Kubernetes, the reader is `load_config` in `controller/utils/config_env.py`.

Expansion is textual, so a reference always yields a string. That is why the schema
allows `${VAR}` only in string fields: a `replicas` of `"3"` would start one replica.

## Validation

`schema/` checks a deployment before any stub is generated. `check_deployment` in
`schema/__init__.py` returns the parsed manifest and every violation of every file, and
never raises. It runs in two places:

- the in-container deploy, before anything is built (`_validate_or_exit` in `cli.py`);
- a reload, before anything changes (`POST /reload` in `server.py`, then
  `reload_config`).

`check_project` checks one project's files the same way. `canyonos validate` (Core
`validate.py`) runs it and adds the checks the schema cannot make. The in-cluster build
on Kubernetes checks its config with `_validate_or_exit` (`kubernetes/commands.py`).

| Module                 | What it holds                                                                    |
| ---------------------- | -------------------------------------------------------------------------------- |
| `manifest.py`          | The schema of both files, `load_project` and `load_deployment`                   |
| `functions.py`         | An agent's `functions`                                                           |
| `kubernetes_block.py`  | The `kubernetes:` section, read only by a Kubernetes deploy                      |
| `otel_destinations.py` | `otel.destinations`, shared with the exporter at runtime                         |
| `_checks.py`           | The field readers every module uses, including the `${VAR}` rule                 |
| `yaml_lines.py`        | A YAML loader that keeps line numbers, so each violation names its line          |
| `errors.py`            | `SchemaViolation` and `SchemaError`; each violation renders as one line          |
| `__init__.py`          | `check_project` and `check_deployment`, which also check every `entrypoint`      |

`load_deployment` parses `deployment.yaml` and every project's config into frozen
dataclasses (`Manifest`, `CodeAgent`, `DatabaseAgent`, `Resources`, `RedisSpec`,
`OtelSpec`, `EndpointSpec`, `RouteSpec`) and collects every violation before raising one
`SchemaError`. Function names become Python source in the stub, so argument types are
limited to builtins.

The allowed keys are declared once, at the top of `manifest.py`: a project's top-level
keys in `_PROJECT_KEYS`, `deployment.yaml`'s in `_DEPLOYMENT_KEYS`, and entry keys per
type in `_AGENT_KEYS_BY_TYPE`. Anything else is rejected, and a deployment key in a
project's config is refused with a message that sends it to `deployment.yaml`. A key
that no longer does anything goes in `_RETIRED_KEYS`, with the message to show. A
provider's own section (`ec2-pool:`, `ec2-assign:`) is declared in its schema module
instead; see `packages/core/canyonos_core/reconciler/providers/README.md`.

Cross-field rules live in `_agent`, `_agents`, `_routes` and
`_check_provider_sections`:

- A database always has one replica.
- Two agent names that Docker writes the same way collide, since image and container
  names are lowercased and the `.` of `<project>.<agent>` is written `--`.
- Each of a project's `endpoint.routes` names an agent of type `agent` in that project
  and one of its `functions`.
- The section of the deployment's `provider` must set its required keys:
  `machine_type` for both EC2 providers. In `ec2-pool:` it maps each machine type to a
  count; in `ec2-assign:` it maps each agent to a machine type.

## Applying it

`ControllerContext._load_config` (`controller/controller_context.py`) fails when
`deployment.yaml` has no `deployment_id`. `canyonos deploy` adds one on the first
deploy, so it stays the same across reloads and redeploys.
`GlobalController._apply_config` then publishes the config to Redis:

| What                                                                         | Redis key                            | Written by                   |
| ---------------------------------------------------------------------------- | ------------------------------------ | ---------------------------- |
| Each agent's spec, and the list of agents                                    | `agent:{name}:spec`, `agents:active` | `write_config_specs`         |
| Desired replicas                                                             | `agent:{name}:desired_replicas`      | `_apply_configured_replicas` |
| Policy rules, most specific first, on every machine's Redis                  | `policy:rules`                       | `_write_policies`            |
| Every other YAML file in each project's `config/`, on every machine's Redis  | `<file>:config`, `prompts:yaml`      | `_write_policies`            |
| Governance rules from `governance.yaml`, for agents the dashboard hasn't set | `governance:config`                  | `_seed_governance`           |
| The deployment's identity                                                    | `controller:identity`                | `_write_identity`            |
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

1. Copy the projects named and `deployment.yaml` into the container, as a deploy does.
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

1. Add the key to `_DEPLOYMENT_KEYS` or the right agent key set in `manifest.py`, and a
   field with its default to the matching dataclass.
2. Parse it in `load_deployment` or `_agent` with the helpers in `schema/_checks.py`.
3. Read it where it's used, and publish it in `_apply_config` if other processes need
   it. On Kubernetes, the Global Controller reads the same file from the ConfigMap; a
   setting the operator acts on, such as an agent's resources, also goes into the
   CanyonProject or CanyonAgent that `kubernetes/manifests.py` renders.
4. Add an E2E schema check, and document the setting in
   [Workflow config](../guides/WORKFLOW_CONFIG.md).
