# Configuration internals

How a project's config gets from the files a user edits to the running system. For
what each setting means, see [the user guide](../guides/GLOBAL_CONTROLLER.md).

## Where the files are

The CLI looks for `.car/config/global_controller.yaml`, then
`config/global_controller.yaml` (`default_config_path` in
`packages/cli/canyonos/constants.py`). `canyonos config` edits that file on the host
and nothing else.

On `canyonos deploy`, the CLI copies the project into the Global Controller
container's `/workspace` with `docker cp` (`packages/cli/canyonos/sync.py`). The
container reads only that copy, so a host-side edit reaches it on the next deploy.

## Loading

Every reader goes through `load_config` in
`packages/core/canyonos_core/controller/utils/config_env.py`:

1. Import the project root's `.env` into the process environment, without overriding
   variables that are already set.
2. Parse the YAML.
3. Replace every `${VAR}` with the variable's text. Unset references stay as written.

Expansion is textual, so a reference always yields a string. That is why the schema
allows `${VAR}` only in string fields.

## Validation

`packages/core/canyonos_core/schema/` checks a project before any stub is generated.
`validate_project` is what the in-container deploy calls.

- `manifest.py`: `global_controller.yaml`. `load_manifest` parses it into frozen
  dataclasses (`Manifest`, `AgentService`, `WorkflowService`, `DatabaseService`,
  `RedisSpec`, `OtelSpec`, `Ec2Spec`) and collects every violation before raising one
  `SchemaError`.
- `agent_yaml.py`: agent declarations. Their names become Python source in the stub, so
  argument types are limited to builtins.
- `otel_destinations.py`: `otel.destinations`, shared with the runtime.
- `yaml_lines.py`: a YAML loader that keeps line numbers, so each violation names its
  line.
- `__init__.py`: `check_project` ties them together. It also checks that every `agent`
  entry has a declaration with its name and that every `entrypoint` and
  `workflow_file` exists inside the project.

The allowed keys are declared once, at the top of `manifest.py`: top-level keys in
`_MANIFEST_KEYS` and entry keys per type in `_SERVICE_KEYS_BY_TYPE`. Anything else is
rejected. A key that no longer does anything goes in `_RETIRED_KEYS` with the message
to show.

Cross-field rules live in `_service` and `_ec2`:

- `provider: EC2` needs `instance_type`, and then the `ec2` section.
- A local workflow can't have more than one replica, since they would share `api_port`.
- A database always has one replica.
- Two entry names that differ only in case collide, since image and container names
  are lowercased.

## Applying it

`GlobalController._load_config` adds a `project_id` on first load and writes it back
into the file, so it stays the same across reloads. `_apply_config` then publishes the
config to Redis:

| What | Redis key | Written by |
|---|---|---|
| Each agent's spec | `agent:{name}:spec` | `write_config_specs` |
| Desired replicas | `agent:{name}:desired_replicas` | `_apply_configured_replicas` |
| Policy rules, sorted most specific first | `policy:rules`, on every host | `_load_and_write_policies` |
| OTel destinations | `otel:destinations` | `_write_otel_destinations` |

The YAML always wins: every load overwrites replica counts changed at runtime. The
Reconciler converges running instances onto the new desired counts; see
[RECONCILER.md](../architecture/RECONCILER.md).

## Reloading

`reload_config` runs on `SIGHUP` to the Global Controller. It re-reads the file,
republishes it, deletes the desired count of any agent that was removed, and wakes the
Reconciler, without restarting the agents that remain. The CLI doesn't send `SIGHUP`
today, so users apply changes with `canyonos deploy`.

## Adding a setting

1. Add the key to `_MANIFEST_KEYS` or the right service key set in `manifest.py`, and
   a field with its default to the matching dataclass.
2. Parse it in `load_manifest` or `_service` with the helpers in `schema/_checks.py`.
3. Read it where it's used, and publish it in `_apply_config` if other processes need it.
4. Add schema tests in `packages/core/tests/`, and document it in
   [the user guide](../guides/GLOBAL_CONTROLLER.md).
