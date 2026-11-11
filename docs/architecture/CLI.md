# CLI

The `canyonos` command line is a thin client. On Docker it never builds or runs the
workflow itself: it starts a Global Controller container for the project, copies the
project into it, and drives it over a small HTTP API. What it prints during a deploy is
a summary of that container's log. On Kubernetes it hands the project to the CanyonOS
operator through `kubectl`. The CLI runs on Linux, macOS and Windows.

This page is for contributors. Every command's options, from a user's side, are in the
[CLI reference](../guides/CLI.md).

## Code

All paths are under `packages/cli/`. `pyproject.toml` installs the `canyonos` command
as `cli:main`.

| Path                                                                                            | What it holds                                                                                       |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `cli.py`                                                                                        | The parser, `--target` routing, the upgrade notice and usage recording around every command         |
| `utils/help_screen.py`                                                                          | The help screen and `DESCRIPTIONS`, the one list of commands `cli.py` registers from                |
| `utils/tui.py`                                                                                  | `select_menu` and `input_line`, the arrow-key menus                                                 |
| `canyonos/deploy.py`                                                                            | `canyonos deploy` on Docker: the checks, the sync, `POST /deploy`, the log summary (`PhaseTracker`) |
| `canyonos/init.py`                                                                              | Starting the Global Controller container, choosing its ports, writing `state.json`                  |
| `canyonos/gc.py`                                                                                | Every request to the Global Controller container's HTTP API                                         |
| `canyonos/sync.py`                                                                              | `canyonos sync`: `docker cp` into `/workspace`, `POST /reload`, the fingerprints                    |
| `canyonos/test.py`, `verify.py`                                                                 | `canyonos test`, and its check of the images and replicas                                           |
| `canyonos/convert.py`                                                                           | `canyonos convert`: the coding agents, the skill install, the `validate` check                      |
| `canyonos/validate.py`                                                                          | `canyonos validate`, which runs `canyonos_core.validate`                                            |
| `canyonos/config.py`, `resources.py`                                                            | `canyonos config`, and the resource picker `deploy` shows                                           |
| `canyonos/stop.py`, `clean.py`                                                                  | `canyonos stop` and `canyonos clean`, with and without `--all`                                      |
| `canyonos/logs.py`, `status.py`, `doctor.py`                                                    | `canyonos logs`, `status` and `doctor`                                                              |
| `canyonos/serve.py`, `dashboard_stack.py`, `dashboard_registration.py`, `dashboard.compose.yml` | The local dashboard: `canyonos serve`, its compose stack, project registration                      |
| `canyonos/project.py`                                                                           | The project name, Docker names and labels, the `target`, the paths under `~/.canyonos/projects`     |
| `canyonos/constants.py`                                                                         | The project root, the config path, config reads and writes, default ports                           |
| `canyonos/env.py`                                                                               | `CANYONOS_ENV` and the development overrides                                                        |
| `canyonos/target.py`                                                                            | `canyonos target`                                                                                   |
| `canyonos/kubernetes_target.py`, `forwards.py`                                                  | `deploy`, `status`, `logs`, `stop`, `clean` and `serve` on Kubernetes; background port-forwards     |
| `canyonos/kubernetes_local.py`                                                                  | `canyonos cluster up` and `down`                                                                    |
| `canyonos/quickstart.py`, `new_app.py`, `new_app_template/`                                     | `canyonos quickstart` and `canyonos new-app`                                                        |
| `canyonos/provision.py`, `aws_provision.py`, `dev_machine.py`                                   | `canyonos provision`: an EC2 machine to deploy from                                                 |
| `canyonos/usage/`, `contact.py`, `feedback.py`                                                  | Usage reporting, `canyonos contact` and `canyonos feedback`                                         |
| `canyonos/upgrade.py`                                                                           | `canyonos upgrade`, and the notice when a newer CLI is out                                          |
| `canyonos/ui.py`, `theme.py`                                                                    | Every line the CLI prints, with one palette, set of symbols and spinner                             |
| `canyonos/os_support/`                                                                          | What differs between Linux, macOS and Windows: terminal input, file locks, private files            |
| `canyonos/docker_cmd.py`, `port_utils.py`                                                       | Docker calls with timeouts; port choice, a byte-for-byte twin of core's                             |
| `tests/`, `tests/e2e/`                                                                          | Unit tests, and the end-to-end suite                                                                |

Most commands act on the project in the folder they run from. Its files are read from
the project root: `.canyon` when that folder exists, else the folder itself. The
workflow config is `config/workflow_config.yaml` under the project root, and `.env`
is always the one in the folder `canyonos` runs in.

## Talking to the Global Controller

```text
canyonos CLI
 ├─ HTTP :8000 (/deploy, /reload, /clean, /status, /endpoint) ─► Global Controller
 ├─ docker cp: copies the workflow into /workspace ─────────────► Global Controller
 ├─ docker logs -f: streams its log ◄──────────────────────────── Global Controller
 └─ docker compose: starts the dashboard (web, API)

Global Controller container (canyonos-<project>-global-controller)
 ├─ docker.sock: starts Redis, the agent replicas and the endpoint as sibling containers
 └─ OTLP exporter: sends telemetry to the dashboard
```

`canyonos deploy` starts one container per project from the core image
(`canyonos/init.py`, `_run_container`):

| Setting       | Value                                                                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name          | `canyonos-<project>-global-controller`                                                                                                                                 |
| Labels        | `com.docker.compose.project=canyonos-<project>`, `canyonos.role=global-controller`                                                                                     |
| Port          | `8000` inside, published on `127.0.0.1` at the last deploy's port, else `8000` or the next free one                                                                    |
| Docker socket | The host's socket at `/var/run/docker.sock`: the real socket behind the active context, or the engine's own path when there is none, such as Docker Desktop on Windows |
| Workspace     | The volume `canyonos-<project>-workspace` at `/workspace`                                                                                                              |
| Network       | The project's own network `canyonos-<project>`, created if missing, with `host.docker.internal` pointing at the host                                                   |

Because the container uses the host's Docker engine, the Redis, replica and endpoint
containers it starts are siblings on this machine, not nested inside it. Ctrl+C does
not stop them; `canyonos stop` does.

The container's server is `canyonos_core/server.py` (see
[Controller](CONTROLLER.md#where-it-runs)). The CLI calls it at
`http://127.0.0.1:<port>`, through the helpers in `canyonos/gc.py`:

| Request                   | Helper              | Called by                                                                   | What the server does                                                              |
| ------------------------- | ------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `POST /deploy`            | `post_deploy`       | `deploy`, `test`                                                            | Starts `python -m canyonos_core.cli deploy` in `/workspace`; `409` if one runs    |
| `POST /reload`            | `post_reload`       | `sync`, `config`                                                            | Checks the synced config, then sends the deploy SIGHUP; `400` lists every problem |
| `POST /clean`             | `post_clean`        | `stop_project` (`stop`, `clean`, `deploy`, `test`), `stop --all`            | Sends the deploy SIGTERM and waits for it to exit; `409` if none runs             |
| `GET /status`             | `deploy_status`     | `deploy`, `test`, `sync`, `logs`, `status`, `serve`, `doctor`, `quickstart` | `{"running": true}` while a deploy runs                                           |
| `GET /endpoint`           | `deployed_endpoint` | `deploy`, `test`, `status`, `doctor`, `quickstart`                          | The [endpoint record](ENDPOINT.md#where-callers-find-it)                          |
| `GET /runtime_status`     | `runtime_status`    | `status`                                                                    | Each agent's desired and running replicas and last launch error                   |
| `GET /logs/<name>?tail=N` | `deployed_logs`     | `logs <agent>`                                                              | The last lines of each replica of an agent, or of one replica                     |

### Copying the project in

The project reaches the container as a copy, not a live mount (`canyonos/sync.py`,
`run_sync`). `docker cp` copies the contents of the project root into `/workspace`, and
the `.env` of the folder `canyonos` runs in to `/workspace/.env`. A manifest,
`sync-manifest.json`, records what each sync copied; the next sync first removes the
paths that are gone from the project, and leaves files the build wrote in the
container alone.

Editing a file after a deploy changes nothing in the container until the next
`canyonos sync` or `canyonos deploy`. Every deploy removes the previous container and
its volume first, so each one starts from an empty `/workspace`.

### Reading the log

The deploy's output goes to the container's log, and the CLI follows it with
`docker logs -f`, by container name (`canyonos/deploy.py`). Lines are read on a thread
into a queue, so a silent stream does not block: after 2 seconds without a line the CLI
asks `GET /status`, and two checks in a row that find no running deploy end the wait.

`PhaseTracker` turns the lines into a few progress messages and decides what is fatal:
`ERROR:`, `CRITICAL:`, a Python traceback, or a failed `docker buildx` step.
OpenTelemetry export errors, expected while the dashboard is not up yet, are skipped.
Lines inside a quoted container log, which the Global Controller prints for a replica
that failed, never decide anything. The workflow is up at the line
`Global controller started, polling every`. With `-v`, every line is printed as it
comes; the same tracker still decides failure.

## Commands

### deploy

```text
You                    CLI                                Global Controller
 │                      │                                         │
 │ canyonos deploy      │                                         │
 ├─────────────────────►│                                         │
 │                      │ checks, the resource picker             │
 │                      │ docker run the core image               │
 │                      ├────────────────────────────────────────►│
 │                      │ docker cp the workflow into /workspace  │
 │                      ├────────────────────────────────────────►│
 │                      │ POST /deploy                            │
 │                      ├────────────────────────────────────────►│
 │                      │                                         │ builds the images, starts
 │                      │                                         │ Redis and the replicas
 │                      │ its log, via docker logs -f             │
 │                      │◄────────────────────────────────────────┤
 │                      │ GET /endpoint                           │
 │                      ├────────────────────────────────────────►│
 │ dashboard URL and    │                                         │
 │ curl commands        │                                         │
 │◄─────────────────────┤                                         │
```

```bash
canyonos deploy [--target docker|kubernetes] [--serve true|false] [-v]
```

`run_deploy` in `canyonos/deploy.py`, in order:

1. Warns about keys `.env.example` lists that `.env` leaves out or empty, makes sure
   Docker is running (and starts Docker Desktop, OrbStack or Colima when it can), and
   runs the checks of `canyonos validate`. Any finding stops the deploy.
2. Shows the resource picker (`canyonos/resources.py`): every agent's `cpu`, `memory`,
   `gpu` and `replicas`, with defaults filled in. In a terminal you can change them,
   and cancelling cancels the deploy. The result is written back to the workflow
   config.
3. Writes a `project_id` to the workflow config when it has none. The project's
   Docker names end with its first 8 characters.
4. `run_init` (`canyonos/init.py`) tears down the project's last deploy, chooses the
   ports, pulls the core image, starts the container, waits for `GET /status` to
   answer, and writes `state.json`. An image other than the release image is used as
   is when the machine already has it.
5. With `--serve true` (the default), starts the dashboard in the background when none
   is running.
6. Takes the project's fingerprints, copies the project in, and writes
   `deployed.json`.
7. Calls `POST /deploy`, then reads the log until the workflow is up. If fewer
   replicas reported healthy than the config declares, the deploy fails.
8. Prints the summary: the dashboard's URL and `curl` commands to call the endpoint,
   answer a question and read a result. When the config sets no `endpoint.api_port`,
   the port the endpoint got is saved in `state.json`, and the next deploy tries it
   first.

Ports: the Global Controller takes the last deploy's port, else `8000` or the next free
one. Redis takes the config's `redis.port`, else the last deploy's, else `6379` or the
next free one. The endpoint takes `endpoint.api_port`, and the deploy fails if that
port is taken; without one, the last deploy's port, else `8080` or the next free one,
never the dashboard's. `canyonos/ports.py` picks them all, and the dashboard's, under
the lock `~/.canyonos/ports.lock`, skipping every port another project's `state.json`,
a port-forward or the dashboard holds, so deploys started together each get their own.
The Global Controller gets those as `CANYONOS_RESERVED_PORTS` and skips them too when
Docker makes it move a port. The full rule is in
[Ports a deploy opens](../guides/WORKFLOW_CONFIG.md#ports-a-deploy-opens).

A deploy that fails before the workflow is up is torn down. In the default view, the
CLI first prints up to 400 lines it hid, keeps printing for up to 30 seconds while the
Global Controller stops, and ends with a "Root Cause" line when one line marked the
failure. After 3 minutes with no
new line, the spinner shows the build step that has been running longest. A deploy
that is not up after 30 minutes fails. Ctrl+C while the log is shown stops only the
CLI: the deploy keeps running, and `canyonos logs` follows it again.

The dashboard is one compose stack per machine, `canyonos-dashboard`, shared by every
project. `canyonos serve` and `deploy` keep its settings and JWT secret in
`~/.canyonos/dashboard/.env`. Every command that starts, stops or removes the stack
holds the lock `~/.canyonos/dashboard/.lock`, so commands from different project
folders wait for each other. The stack's host ports are picked by the same rule as the
project's and saved in `~/.canyonos/dashboard/ports.json`. Once the stack is up, and
only while this folder's Global Controller reports a running deploy, the CLI connects
the dashboard API container to the project's network and sends the project's Redis
container name and port to `POST /canyonos/projects` on the dashboard API
(`canyonos/dashboard_registration.py`). The API reads the controller's identity from
that Redis and keeps its name and port for the project's pages. A failed registration
prints a warning and never fails `serve` or `deploy`; run `canyonos serve` again to
retry. The code marks this per-project Redis address as temporary, until the
project-key design in CAN-521.

### test

```bash
canyonos test [prompt] [--json] [--timeout SECONDS] [--target docker|kubernetes]
```

`run_test` in `canyonos/test.py` sends one prompt through the workflow and reports
what came back. The prompt is the argument, else `config/test_query.txt` (under
`.canyon`, else the folder), else `hello`. It is sent as every argument of the
endpoint's method.

When a deploy of this project is already running, `test` first checks the project's
files against `deployed.json`. If files outside `config/` changed, it fails and names
`canyonos deploy`; if only files in `config/` changed, it names `canyonos sync`.
Otherwise it queries that deploy as it stands and leaves it running.

When none is running, it stands up its own:

1. Sets the workflow config's top-level `provider` to `local` and keeps the file's
   original bytes (`_force_local_providers`).
2. Deploys without the resource picker or the dashboard (`run_deploy(quiet=True)`),
   then waits until the log says the workflow is up and the endpoint answers.
3. Checks the deploy against the config (`canyonos/verify.py`): every agent's image
   exists, and at least as many of its replica containers run as the config declares.
4. Sends the prompt and polls `GET /status/<request_id>` until the request is done,
   fails or the timeout passes (default 300 seconds; it restarts after each answer).
   A question from the workflow is asked in the terminal; with `--json` or without a
   terminal, the test fails and prints the `curl` that answers it.
5. Writes the original config back, whatever happened.

A passing run tears its deploy down. A run that fails after its deploy started leaves
the Global Controller running and prints the last 40 lines of its log and the root
cause, so there is something to debug. With `--json`, the result is one JSON object
and nothing else.

With `--target kubernetes`, `test` never deploys: it queries the project already
deployed in the cluster, through a port-forward to its endpoint.

### convert

```bash
canyonos convert [--agent AGENT] [--scope local|global] [-y] [--install-only]
```

`run_convert` in `canyonos/convert.py` installs the CanyonOS skill,
`converting-to-canyonos`, on a coding agent and has that agent port the project. No
container is involved.

```text
canyonos convert
 ├─ pick the coding agent (--agent) and where the skill goes (--scope)
 ├─ install the skill in the agent's skills folder
 │   └─ with --install-only, stop here
 ├─ run the agent with the convert prompt
 │   └─ the agent writes .canyon/
 └─ canyonos validate .canyon
```

- Agents: `claude` (the default), `codex`, `gemini`, `opencode`, `pi`, `copilot`,
  `cursor`, `droid`, `grok`, `devin`, `mastra`, `deepagents`, `vibe` and `cline`. Each
  entry in `AGENTS` has the agent's command, its flags for an attended and an
  unattended run, and its skills folder.
- Scope: `local` (the default) installs into the agent's folder in this project, such
  as `.claude/skills/converting-to-canyonos`; `global` into the one in your home
  folder, such as `~/.claude/skills/converting-to-canyonos`.
- Without `--agent` and `--scope`, two menus ask, which needs a terminal. `-y` takes
  the defaults for whichever was not given and runs the agent unattended.
- A released CLI fetches the skill from the repository at the tag `v<version>`, with a
  sparse `git clone`, else the tag's tarball, and points the skill's doc links at that
  tag. In development, `CANYONOS_SKILL_SOURCE` can name a directory or another git ref
  instead.
- The prompt asks for the result in a new `.canyon` folder, with the application's own
  source untouched. Attended, the agent takes over the terminal. Unattended (with `-y`,
  or without a terminal), the prompt says nobody can answer, and the agent's output
  goes to `~/.canyonos/projects/<project>/convert.log`.

The command succeeds only when the agent exits with `0`, `.canyon` exists, and
`canyonos validate .canyon` exits `0`. `convert` never deploys.

### sync and config

`canyonos sync` (`run_sync_and_reload`) copies the project into the running deploy's
container, then calls `POST /reload`. The Global Controller rereads the workflow
config and applies it without restarting the agents that stay; see
[Reloading](../contributing/CONFIG.md#reloading). Only the config applies: changed
code is copied too but runs only after the next `canyonos deploy`, so `sync` updates
just the `config` fingerprint in `deployed.json`. With no deploy running, `sync`
copies nothing and says the change applies on the next deploy; when the recorded
container does not answer, it fails and suggests `canyonos stop`.

`canyonos config` opens a menu (`canyonos/config.py`):

| Choice | What it does                                                                                                                                                                                                                            |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| View   | Prints the workflow config as tables: agents, OTel destinations, every other section, and the top-level values                                                                                                                          |
| Change | Opens a full-screen editor over the config: pick a value to change, `d` to delete, `q` to quit. Each change is written to the file, keeping comments and line endings; when you leave, a running deploy gets it through `canyonos sync` |

`sync` and `config` act only on the Docker deploy recorded in `state.json`. A
Kubernetes project picks up config changes on its next `canyonos deploy`.

### logs, status and doctor

- `canyonos logs` prints the last 200 lines of the Global Controller's log and keeps
  following it (`docker logs -f`). `--tail N` or `--tail all` changes how many,
  `--no-follow` prints and exits, and an agent or replica name prints that one's lines
  instead, through `GET /logs/<name>`.
- `canyonos status` says whether a deploy runs, where its endpoint and the dashboard
  answer, and each agent's last launch error. `--json` prints it as one JSON object,
  with every agent's replica counts and each machine type's last start error.
- `canyonos doctor` checks what a deploy needs before one runs, and every part of a
  running one after. With `--target kubernetes`, it checks the cluster instead.

Each has a Kubernetes version in `canyonos/kubernetes_target.py`.

### stop and clean

Teardown is explicit, at two depths:

| Command          | Containers, network, volume | `state.json` | Agent images | `.canyon`, skill | Dashboard                                          |
| ---------------- | --------------------------- | ------------ | ------------ | ---------------- | -------------------------------------------------- |
| `canyonos stop`  | removed                     | removed      | kept         | kept             | stopped, history kept, unless another project runs |
| `canyonos clean` | removed                     | removed      | removed      | removed          | as `stop`                                          |

Both work from any folder (`canyonos/selection.py`). They take projects by name, folder
name or ID, or the start of one, as Docker takes containers; a name two projects share
is refused, so use the ID. Without names they act on the only deployed project, or
list the candidates in a menu to tick; without a terminal they name them and act on
none. `clean` also offers the current folder's project when it isn't deployed. A
project is deployed while it has a record under `~/.canyonos/projects/<project>/`, so
one whose Global Controller died is still listed.

`stop_project` (`canyonos/stop.py`) asks the running deploy to stop with
`POST /clean`, which removes the Redis, replica and endpoint containers it started.
It then stops and removes the Global Controller container, removes the project's
network and workspace volume, and deletes `deployed.json` and `state.json`. If
anything fails, `state.json` stays, so `canyonos stop` can be retried. When the
project's Global Controller isn't running, why it went down is unknown, so `stop`
refuses unless the project was named or ticked; then it removes everything labelled
with the project. Every `deploy` runs the same stop on the project's last deploy
first, refusing the same way. The dashboard is stopped only when no other Global
Controller runs on the engine (found by the label `canyonos.role=global-controller`).

`canyonos clean` (`canyonos/clean.py`) runs `stop` when a deploy is recorded, and stops
there if it fails. It then removes the project's `.canyon`, the skill `convert`
installs in its folder for any of the 14 agents (global installs stay), its agents'
images `canyonos-<project>-<agent>`, and its records in
`~/.canyonos/projects/<project>/`, its Redis password among them. When the stop fails
or is refused, nothing is removed.

With `--all`, both act on every project with records under `~/.canyonos/projects`,
found by the project label, even when the project's own folder is gone. `--all` and
project names can't be combined. `stop --all` stops the dashboard, sends `POST /clean`
to every running Global Controller, removes those projects' containers, volumes and
networks and the network `canyonos-local` that every project shared in older
releases, then deletes their state files. `clean --all` asks first (or not, with `-y`), then also
removes the dashboard and its data, CanyonOS's own images, every project's agent
images, and `~/.canyonos`. `--all` cannot be combined with `--target kubernetes`.

### Kubernetes: target, cluster, deploy, stop and clean

A project's `target` in the workflow config says where it runs: `docker` (the default)
or `kubernetes`. `--target` on `deploy`, `test`, `status`, `logs`, `serve`, `doctor`,
`stop` and `clean` overrides it for one run (`resolve_target` in
`canyonos/project.py`).

```bash
canyonos target kubernetes [--namespace NAME] [--registry HOST/PATH]
canyonos cluster up [--workers N]
canyonos cluster down [--all]
```

- `canyonos target` (`canyonos/target.py`) with no argument shows the target and
  checks that this machine can reach it. `target kubernetes` writes
  `target: kubernetes` and the `kubernetes:` block's `namespace` (default: the
  folder's name) and `registry` (default: the local registry the cluster advertises,
  else it asks). `target docker` switches back.
- `canyonos cluster up` (`canyonos/kubernetes_local.py`) needs Docker, kind and
  `kubectl`. It makes a registry on `localhost:5001` and a kind cluster with Calico,
  metrics-server and Pod Security `restricted`, installs this CLI's release of the
  operator chart with its builder and dashboard (Helm runs in a container), and points
  `kubectl` at the cluster. Running it again keeps the cluster and upgrades CanyonOS on
  it. `cluster down` deletes the cluster; `--all` also removes the registry. A
  development CLI refuses `cluster up` and points at `scripts/kind/up.sh`.
- `deploy` (`run_kubernetes_deploy`) checks that the operator is installed, creates
  the namespace if needed, stores `.env` as a Secret (unless the `kubernetes:` block
  names one), and creates a CanyonBuild. It stops if the operator's release is not the
  CLI's. It uploads the project root (no
  `.git`, `.venv`, `node_modules`, `__pycache__` or `.env*`) to the build pod through a
  port-forward, waits for the build, then for every agent to be ready. An endpoint
  reachable only inside the cluster is forwarded to `127.0.0.1` by a background
  `canyonos` process, recorded in `~/.canyonos/forwards/`; with `--serve true`, so is
  the cluster's dashboard. `-v` has no effect here.
- `stop` deletes the CanyonProject and waits while the operator drains the agents and
  removes the rest; it closes the endpoint's port-forward, and the dashboard's once no
  other project's endpoint is forwarded. `clean` also deletes the project's ConfigMaps
  and Secrets labeled as the CLI's. Neither deletes the namespace, and `clean` leaves
  `.canyon` and the images on this machine alone.

[Kubernetes deployment](../guides/KUBERNETES.md) covers setup and use, and
[Operator](OPERATOR.md) what the cluster side does.

### quickstart

`canyonos quickstart` (`canyonos/quickstart.py`) walks a new user through six stages:
system prerequisites, workflow selection, workflow setup, deployment, deployment
health, and a first request. At each command stage it shows the command, waits for
the user to type it, then runs it: `canyonos doctor`, `canyonos deploy`,
`canyonos doctor` again, a `curl` to the endpoint, and finally an optional
`canyonos clean`.

The workflows on offer, Hello World (no API key) and Portfolio (an OpenAI key), are
bundled in the package under `starters`, which `scripts/bundle-starters.ts` fills from
`examples/`. The chosen one is copied into a folder of its own in the current
directory. After the first request, the dashboard gets that workflow's recorded example
runs. Ctrl+C leaves a deploy that came up running.

### Usage reporting and feedback

`cli.py` wraps every command in `recording_usage` (`canyonos/usage/outbox.py`). While
usage reporting is on, the default, a reported command (`new-app`, `convert`,
`validate`, `deploy`, `test`, `serve`, `stop`, `clean`) adds an event to
`~/.canyonos/usage/outbox/`: the command, whether it succeeded, when it ran, the CLI
version and a random installation ID. Before the first event, the CLI shows a notice
saying what is sent and how to turn it off. As the command ends, `start_delivery`
starts the CLI again in the background with a hidden argument, and that process sends
the waiting events to the usage API.

`canyonos contact` shows the setting and changes it (`--usage on|off`).
`canyonos feedback "<message>"` sends a message to the same API right away, with the
installation ID only while usage reporting is on. Without one, it asks first, or sends
without asking with `-y`. The [CLI reference](../guides/CLI.md#usage-reporting) has
what each sends.

## State on this machine

`<project>` is the project's name (`project_name` in `canyonos/project.py`): the
folder's name in lowercase, with anything but letters, digits, `_` and `-` turned into
`-`, at most 24 characters, then `-` and the first 8 characters of the workflow
config's `project_id` once it has one.

| Path                                                | Written by                                    | Holds                                                                                                                                                                                                                    |
| --------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `~/.canyonos/projects/<project>/state.json`         | `deploy`                                      | The Global Controller's `container_id` and `port`, the Docker socket it was started on, the Redis port, the endpoint's port, the `project_id` and the project's folder. Every Docker command reads it; `stop` deletes it |
| `~/.canyonos/ports.lock`                            | Commands that pick a port                     | The lock around picking ports, so two commands never pick the same one                                                                                                                                                   |
| `~/.canyonos/dashboard/ports.json`                  | `serve`, `deploy`                             | The host ports the dashboard's services got last, tried first next time                                                                                                                                                  |
| `~/.canyonos/projects/<project>/deployed.json`      | `deploy`, `sync`                              | SHA-256 fingerprints of the project's `code` and `config` as the deploy took them in; `test` compares them. `stop` deletes it                                                                                            |
| `~/.canyonos/projects/<project>/sync-manifest.json` | `sync`, `deploy`                              | The paths the last sync copied, and the container they went to                                                                                                                                                           |
| `~/.canyonos/projects/<project>/convert.log`        | `convert`                                     | The coding agent's output from an unattended run                                                                                                                                                                         |
| `~/.canyonos/projects/<project>/redis_password`     | `deploy`                                      | The password the project's Redis requires, made on the first deploy. `clean` deletes it, and the next deploy makes a new one                                                                                             |
| `~/.canyonos/dashboard/.env`                        | `serve`, `deploy`                             | The dashboard stack's settings and JWT secret                                                                                                                                                                            |
| `~/.canyonos/dashboard/.lock`                       | Commands that start, stop or remove the stack | The lock around the dashboard stack                                                                                                                                                                                      |
| `~/.canyonos/dashboard/logs/serve-<time>.log`       | `serve`                                       | The stack's recent logs, secrets removed, when it fails to start                                                                                                                                                         |
| `~/.canyonos/forwards/<name>.json`                  | `deploy`, `serve` on Kubernetes               | One record per background port-forward; deleting it ends the forward                                                                                                                                                     |
| `~/.canyonos/kind/`                                 | `cluster up`                                  | The Pod Security file the kind cluster's API server reads                                                                                                                                                                |
| `~/.canyonos/usage/settings.json`, `outbox/`        | Usage reporting, `contact`                    | The usage choice and installation ID, and the events waiting to be sent                                                                                                                                                  |
| `~/.canyonos/supported-versions.json`               | The upgrade notice                            | The supported CLI versions, fetched at most once a day                                                                                                                                                                   |

`clean --all` deletes all of `~/.canyonos`.

The CLI also writes to the project's workflow config: `project_id` (`deploy`, `test`),
each agent's resources (`deploy`), `target` and the `kubernetes:` block (`target`), and
whatever you change in `canyonos config`. `test` changes `provider` and puts the file
back. Every write keeps the file's comments, key order, line endings and byte-order
mark (`write_config` in `canyonos/constants.py`).

## Configuration

The CLI's environment is resolved once, in `canyonos/env.py`. It loads
`packages/cli/.env`, next to its own code, never the `.env` of the folder it runs in;
a variable set in the shell wins over that file. A released CLI has no such file, so
it runs in `production`.

| Variable                                   | Values                                       | What it does                                                                                                                                                                                                                                                                                   |
| ------------------------------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CANYONOS_ENV`                             | unset or `production`, `development`, `test` | `production` refuses the image and skill overrides below. `development` and `test` allow them, `canyonos -v` prints the environment's name, and the upgrade notice is off. `development` also skips the operator release check and refuses `cluster up`. The CLI's end-to-end tests set `test` |
| `CANYONOS_CORE_IMAGE`                      | `prod`, `local`, an image                    | The Global Controller image. `prod`: `ghcr.io/canyoncodecoreai/canyonos-core:<version>`; `local`: `canyonos-core:dev`                                                                                                                                                                          |
| `CANYONOS_SKILL_SOURCE`                    | `prod`, `local`, a directory or git ref      | The skill `convert` installs. `prod`: the tag `v<version>`; `local`: `skills/converting-to-canyonos` in the checkout                                                                                                                                                                           |
| `CANYONOS_API_IMAGE`, `CANYONOS_WEB_IMAGE` | `prod`, `local`, an image                    | The dashboard images. `local`: `canyonos-api:dev`, `canyonos-web:dev`                                                                                                                                                                                                                          |
| `CANYONOS_USAGE_URL`                       | a URL, empty, `off`                          | The usage API for usage events and `feedback`. Unset: Canyon Code's in `production`, none otherwise. Empty, `off`, or anything but `https` or `http` to this machine: none                                                                                                                     |
| `CANYONOS_KIND_CLUSTER`                    | a name                                       | The kind cluster `cluster up` and `down` act on; default `canyonos`                                                                                                                                                                                                                            |
| `CANYONOS_DOCKER_PLATFORM`                 | a platform, such as `linux/amd64`            | Passed to the Global Controller container, which builds the agent images for it                                                                                                                                                                                                                |
| `DOCKER_HOST`                              | an engine URL                                | The Docker engine, as for `docker` itself; else the active context's                                                                                                                                                                                                                           |

[Development](../contributing/DEVELOPMENT.md#environment-variables) shows how to set
these up in a checkout.

The CLI sets these in the Global Controller container (`_run_container` in
`canyonos/init.py`):

| Variable                                     | Value                                                                                                       |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `CANYONOS_REDIS_HOST`, `CANYONOS_REDIS_PORT` | The Redis container's name, `canyonos-<project>-redis-localhost`, and the Redis port chosen for this deploy |
| `CANYONOS_LAST_API_PORT`                     | The endpoint's port to try first, when the config sets no `endpoint.api_port`                               |
| `CANYONOS_RESERVED_PORTS`                    | The ports other CanyonOS parts hold, and this container's own, which a port that has to move skips          |
| `DOCKER_HOST`                                | `unix:///var/run/docker.sock`, the mounted socket                                                           |
| `CANYONOS_CONTROLLER_IMAGE`                  | The image the container runs, which it also starts the endpoint and this machine's metrics collector from   |
| `CANYONOS_COLLECTOR_IMAGE`                   | The release image, for the metrics collector on other machines                                              |
| `CANYONOS_DOCKER_PLATFORM`                   | The host's value, when set                                                                                  |
| `CANYONOS_DOCKER_PROJECT`                    | `<project>`, which names and labels every container the deploy starts                                       |
| `CANYONOS_PRIVATE_IP`, `CANYONOS_PUBLIC_IP`  | This machine's addresses on EC2, from the instance metadata, when it has them                               |

## Changing the CLI

Run it from a checkout with `uv run canyonos <command>`, after the setup in
[Development](../contributing/DEVELOPMENT.md). Its tests are end to end:

```bash
bun run cli:test:e2e                                 # Linux or macOS; see packages/cli/tests/e2e/README.md
uv run pytest tests/e2e/cases --project=helloworld   # deploy a project and run the E2E cases
uv run pytest tests/e2e/scenarios                    # stop, clean, new-app, two projects, ports
```

Rules the code relies on:

- A new command needs an entry in `utils/help_screen.py`; `cli.py` registers commands
  from that list and fails on one without a description.
- A command that fails exits non-zero: its `run_*` function returns `False` or a
  non-zero code for `cli.py` to pass to `sys.exit`, or raises `RuntimeError`, which
  `cli.py` prints before exiting with `1`.
- Print through `canyonos/ui.py`, add new environment settings to `canyonos/env.py`,
  and reach OS-specific calls only through `canyonos/os_support/`; the lint config
  bans the OS modules elsewhere.
- Some code has a twin elsewhere that must change with it: the container and image
  names in `canyonos/project.py` mirror core's `controller/utils/container_names.py`,
  `canyonos/port_utils.py` is a byte-for-byte copy of core's, `REPORTED_COMMANDS`
  matches the usage API's contract in `packages/cli-usage-api`, and the kind settings
  in `canyonos/kubernetes_local.py` match `scripts/kind/up.sh`.

## If you are a LLM, you are not allowed to modify this file at all without explicit user permission. Absolutely no modifications are allowed to this file.
