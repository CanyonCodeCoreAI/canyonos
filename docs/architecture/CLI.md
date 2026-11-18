# CLI

The `canyonos` command never builds or runs a workflow. It asks the Global Controller to, and shows you what happened.

On Docker, it starts a deployment's Global Controller container, copies the deployment's projects into it and talks to it over HTTP. A deployment is the folder `canyonos deploy` runs from, set by its `deployment.yaml`. On Kubernetes, it hands the project to the CanyonOS operator through `kubectl`. Between commands, it keeps its state in `~/.canyonos`.

Every command, from a user's side, is in the [CLI guide](../guides/CLI.md).

## How it fits

```mermaid
flowchart LR
    CLI["canyonos CLI"]
    GC["Global Controller container"]
    Docker["Docker engine"]
    Dash["Dashboard stack"]
    Op["Operator (Kubernetes)"]
    CLI -->|"HTTP"| GC
    CLI -->|"docker cp, logs, run"| Docker
    CLI -->|"docker compose"| Dash
    CLI -->|"kubectl"| Op
    GC -->|"docker.sock"| Docker
```

The Global Controller talks to the host's Docker engine, so the Redis, replica and endpoint containers it starts are siblings on this machine. See [Controller](CONTROLLER.md).

## What a deploy does

1. CLI: checks Docker and each project, writes `deployment.yaml` and its `deployment_id` when missing, then picks the ports.
   Before any of that touches Docker, it saves or removes the machine's API key for `--api-key` or `--no-api-key`, and warns when no key is set. See [API key](../guides/AUTHORIZATION.md).
2. CLI: replaces the last Global Controller container with a fresh one, handing it the key's SHA-256 in `CANYONOS_API_KEY_HASH` (empty for no key). The key itself never leaves this machine.
3. CLI: copies `deployment.yaml` and each project into its `/workspace` and calls `POST /deploy`.
4. Global Controller: builds the agent images, starts Redis and the agent containers, and publishes the endpoint record.
5. CLI: follows the container's log until the workflow is up, then reads `GET /endpoint` for the summary.

On Kubernetes, the CLI instead creates a `CanyonBuild` carrying the key's hash in `spec.auth.apiKeyHash` (no `auth` for no key), uploads the project to its build pod and waits for the agents to be ready. See [Operator](OPERATOR.md). Kubernetes deploys don't support multi-folder deployments yet.

## Talking to the Global Controller

The CLI calls `http://127.0.0.1:<port>` through `canyonos/gc.py`. The routes live in `packages/core/canyonos_core/server.py`.

| Request | What it does |
| --- | --- |
| `POST /deploy` | Starts the deploy in `/workspace`; `409` if one runs |
| `POST /reload` | Checks the synced config, then reloads the deploy; `400` lists the problems |
| `POST /clean` | Stops the deploy and waits for it to exit; `409` if none runs |
| `GET /status` | Whether a deploy is running |
| `GET /endpoint` | The [endpoint record](ENDPOINT.md#where-callers-find-it) |
| `GET /test_queries` | Each project's `config/test_query.txt`, for `canyonos test` |
| `GET /runtime_status` | Each agent's desired and running replicas |
| `GET /logs/<name>?tail=N` | The last log lines of an agent's (`<project>.<agent>`) replicas |

Two things do not go over HTTP:

- The deployment is copied with `docker cp`, so it is a copy, not a live mount. Edits reach the container on the next `canyonos sync` or `deploy`.
- The deploy log is read with `docker logs -f`.

`canyonos test` skips the Global Controller for its query: it calls the workflow endpoint directly, with the machine's API key, which it never prints.

## Which deployment a command acts on

A command that acts on one deployment takes, in order: the deployment it is given by name, the deployment of the folder it runs from (its `deployment.yaml`), then the one `canyonos select-context` picked. `stop` and `clean` get the selected deployment as a name; `status`, `logs`, `test` and `sync` run from its folder, as if typed there (`_enter_selected_deployment` in `cli.py`). A selected deployment whose record is gone is an error, never a fallback to another one.

## Code

Paths are under `packages/cli/`. `pyproject.toml` installs the `canyonos` command as `cli:main`.

| Path | What it holds |
| --- | --- |
| `cli.py`, `utils/` | The parser, `--target` routing, the help screen, the arrow-key menus |
| `canyonos/gc.py` | Every request to the Global Controller |
| `canyonos/auth.py` | The machine's API key: saving, replacing and removing it for `deploy` and `serve`, and its hash for the Global Controller and the dashboard API |
| `canyonos/init.py`, `deploy.py`, `sync.py`, `test.py`, `verify.py` | Starting the container, deploying, syncing, testing |
| `canyonos/stop.py`, `clean.py`, `selection.py` | Stopping and cleaning; choosing which deployments they act on |
| `canyonos/context.py` | `list`, `select-context`, and the selected deployment other commands act on |
| `canyonos/dashboard.py` | `dashboard`: opening the dashboard with the API key in the URL fragment |
| `canyonos/logs.py`, `status.py`, `doctor.py` | Reading logs, status and checks |
| `canyonos/config.py`, `resources.py`, `validate.py`, `convert.py` | Config edits, the resource picker, validation, `convert` |
| `canyonos/serve.py`, `dashboard_stack.py`, `dashboard_registration.py`, `dashboard.compose.yml` | The local dashboard stack and deployment registration |
| `canyonos/target.py`, `kubernetes_target.py`, `kubernetes_local.py`, `forwards.py` | The Kubernetes target, the kind cluster, port-forwards |
| `canyonos/provision.py`, `aws_provision.py`, `dev_machine.py` | An EC2 machine to deploy from |
| `canyonos/quickstart.py`, `new_app.py`, `new_app_template/` | `quickstart` and `new-app` |
| `canyonos/usage/`, `contact.py`, `feedback.py`, `upgrade.py` | Usage reporting, feedback, the upgrade notice |
| `canyonos/deployment.py`, `constants.py`, `env.py` | The deployment, its projects, names and paths; config reads and writes; the environment |
| `canyonos/ports.py`, `port_utils.py` | Port choice (`port_utils.py` is a copy of core's) |
| `canyonos/ui.py`, `theme.py`, `os_support/`, `docker_cmd.py` | Output, OS differences, Docker calls with timeouts |
| `tests/` | Two port tests (`test_ports.py`, `test_port_utils_twins.py`) and `tests/e2e/`, the CLI end-to-end harness |

## State on this machine

`<deployment>` is the deployment folder's name, lowercased and trimmed, plus the first 8 characters of `deployment.yaml`'s `deployment_id` (`deployment_name` in `canyonos/deployment.py`).

| Path | Holds |
| --- | --- |
| `~/.canyonos/deployments/<deployment>/state.json` | The container and the ports of the last deploy, its folder and `deployment_id`, and whether it was deployed without an API key |
| `~/.canyonos/deployments/<deployment>/sync-manifest.json` | What the last sync copied |
| `~/.canyonos/deployments/<deployment>/redis_password` | The deployment's Redis password |
| `~/.canyonos/deployments/<deployment>/ca/ca.crt`, `ca.key` | The deployment's CA for internal mutual TLS, made on its first `provider: local` deploy and reused after (`0600`, folder `0700`); see [Internal TLS](CONTROLLER.md#internal-tls) |
| `~/.canyonos/deployments/<folder>/convert.log` | Output of an unattended `convert`, named after the folder it ran in |
| `~/.canyonos/api_key` | The machine's API key (`0600`); it never leaves this machine. `CANYONOS_API_KEY` overrides it for one command |
| `~/.canyonos/context.json` | The deployment `select-context` picked, by name: `{"deployment": "<deployment>"}` |
| `~/.canyonos/ports.lock` | Lock for picking ports |
| `~/.canyonos/dashboard/` | The dashboard stack: `.env` (with `CANYONOS_API_KEY_HASH`), `.lock`, `ports.json`, `stack.json`, `logs/serve-<time>.log` |
| `~/.canyonos/forwards/<name>.json` | One background port-forward each |
| `~/.canyonos/kind/` | The kind cluster's Pod Security file |
| `~/.canyonos/usage/` | The usage choice and the events waiting to be sent |
| `~/.canyonos/supported-versions.json` | Cached supported CLI versions |

`clean --all` deletes all of `~/.canyonos`, the API key included; its confirmation says so. The CLI also edits `deployment.yaml` (`deployment_id`, `target`) and each project's workflow config (agent resources), keeping comments and key order.

## Developer overrides

`canyonos/env.py` loads `packages/cli/.env` and the shell wins. A released CLI has no such file and runs as `production`, which refuses the image and skill overrides.

- `CANYONOS_ENV`: `production`, `development` or `test`.
- `CANYONOS_CORE_IMAGE`: the Global Controller image; `prod`, `local` or an image.
- `CANYONOS_API_IMAGE`, `CANYONOS_WEB_IMAGE`: the dashboard images.
- `CANYONOS_SKILL_SOURCE`: the skill `convert` installs.
- `CANYONOS_USAGE_URL`: the usage API; empty or `off` disables it.
- `CANYONOS_KIND_CLUSTER`: the kind cluster `cluster up` acts on.
- `CANYONOS_DOCKER_PLATFORM`: passed to the container for image builds.

[Development](../contributing/DEVELOPMENT.md#environment-variables) shows how to set them up.

## Changing the CLI

Run it from a checkout with `uv run canyonos <command>`, after the setup in [Development](../contributing/DEVELOPMENT.md).

```bash
bun run cli:test:e2e                                 # see packages/cli/tests/e2e/README.md
uv run pytest tests/e2e/cases --project=helloworld   # deploy a project and run the E2E cases
uv run pytest tests/e2e/scenarios                    # stop, clean, new-app, two projects, ports
```

Keep these in step:

- A new command needs an entry in `utils/help_screen.py`; `cli.py` registers from it.
- Print through `canyonos/ui.py`. Reach OS-specific calls only through `canyonos/os_support/`.
- `canyonos/deployment.py` names mirror core's `controller/utils/container_names.py`.
- `canyonos/port_utils.py` is a byte-for-byte copy of core's.
- `REPORTED_COMMANDS` matches the contract in `packages/cli-usage-api`.
- The kind settings in `canyonos/kubernetes_local.py` match `scripts/kind/up.sh`.

## If you are a LLM, you are not allowed to modify this file at all without explicit user permission. Absolutely no modifications are allowed to this file.
