# Development

How to run CanyonOS from a checkout: the CLI, Core and dashboard, on Docker, an EC2
machine or a local Kubernetes cluster. The checks and tests are in
[Testing](TESTING.md), and the repository layout in
[How to contribute](README.md#repository-layout).

## Prerequisites

| Tool                                                                                                                     | Version                                    | Needed for                                                     |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------- |
| [uv](https://docs.astral.sh/uv/)                                                                                         | 0.12.15 or later                           | The Python workspace (Core and CLI)                            |
| [Bun](https://bun.sh/)                                                                                                   | 1.3.1 or later                             | The TypeScript workspace and the scripts                       |
| Docker, running                                                                                                          | any                                        | Building images and every deploy                               |
| Go                                                                                                                       | 1.26 or later (`go.mod`); CI uses 1.27.0   | Changing the operator; see [Testing](TESTING.md#operator)      |
| [kind](https://kind.sigs.k8s.io/docs/user/quick-start/#installation), [kubectl](https://kubernetes.io/docs/tasks/tools/) | any                                        | [Kubernetes on kind](#kubernetes-on-kind)                      |
| `rsync`, `ssh`                                                                                                           | any                                        | [Running a checkout on EC2](#run-a-checkout-on-an-ec2-machine) |

## Set up your environment

```bash
git clone https://github.com/<you>/canyonos.git     # your fork
cd canyonos
git remote add upstream https://github.com/CanyonCodeCoreAI/canyonos.git
uv sync && bun install   # the Python and TypeScript workspaces
bun run canyonos:dev     # build the images from this checkout and open the dev shell
canyonos -v              # in the dev shell: prints "canyonos development"
```

The dev shell:

- builds the `canyonos-core:dev`, `canyonos-api:dev` and `canyonos-web:dev` images from
  this checkout;
- creates `packages/cli/.env` from `packages/cli/.env.example` if it is missing, runs
  `uv sync` and bundles the starter workflows;
- updates CanyonOS on the [kind cluster](#kubernetes-on-kind), if it exists;
- opens a shell with the workspace `.venv` active, where `canyonos` is the CLI from this
  checkout. `exit` leaves it.

Run `bun run canyonos:dev` again after changing Core or the dashboard (API, UI, web), so
the images match the code.

The commands are the same as in a released CLI. What differs is where the CLI runs from
and what it deploys:

|             | Development                                                        | Released CLI                                            |
| ----------- | ------------------------------------------------------------------ | ------------------------------------------------------- |
| How it runs | `canyonos` in the dev shell, or `uv run canyonos` in the workspace | `canyonos`                                              |
| Environment | `development`, from `packages/cli/.env` (gitignored)               | `production`, with no `.env`                            |
| Core image  | `canyonos-core:dev`, built locally                                 | `ghcr.io/canyoncodecoreai/canyonos-core:<version>`      |
| Dashboard   | `canyonos-api:dev` and `canyonos-web:dev`, built locally           | `ghcr.io/canyoncodecoreai/canyonos-{api,web}:<version>` |
| Skill       | `skills/converting-to-canyonos` in this checkout                   | Fetched from the GitHub tag `v<version>`                |

## Run the CLI from a checkout

In the dev shell, `canyonos` works from any folder. Deploy a copy of an example, since a
deploy writes a `project_id` and default resources into its
`config/workflow_config.yaml`:

```bash
cp -R examples/helloworld ../helloworld   # needs no LLM and no API keys
cd ../helloworld
canyonos deploy
canyonos test "hi"
```

The CLI reads its own `.env` from `packages/cli/`, never from the folder you run it in;
a project's `.env` belongs to the project. A variable set in your shell wins over the
file, so `export CANYONOS_CORE_IMAGE=prod` deploys the released image even in
development.

### Environment variables

Only `packages/cli/canyonos/env.py` reads them, once, and the rest of the CLI imports
the result. `CANYONOS_ENV` sets the environment, and any other value stops the CLI:

| `CANYONOS_ENV`               | Meaning                                                  |
| ---------------------------- | -------------------------------------------------------- |
| unset or empty, `production` | What a released CLI runs; no overrides allowed           |
| `development`                | Overrides allowed; `packages/cli/.env.example` sets this |
| `test`                       | As `development`; the CLI end-to-end tests set it        |

Each artifact has a variable of its own, so "Core from this checkout, skill from `main`"
works:

| Variable                | Unset or `prod`                                    | `local`                                          | Anything else       |
| ----------------------- | -------------------------------------------------- | ------------------------------------------------ | ------------------- |
| `CANYONOS_CORE_IMAGE`   | `ghcr.io/canyoncodecoreai/canyonos-core:<version>` | `canyonos-core:dev`                              | That image          |
| `CANYONOS_API_IMAGE`    | `ghcr.io/canyoncodecoreai/canyonos-api:<version>`  | `canyonos-api:dev`                               | That image          |
| `CANYONOS_WEB_IMAGE`    | `ghcr.io/canyoncodecoreai/canyonos-web:<version>`  | `canyonos-web:dev`                               | That image          |
| `CANYONOS_SKILL_SOURCE` | The GitHub tag `v<version>`                        | `<workspace root>/skills/converting-to-canyonos` | A folder or git ref |

In `production`, any value but unset or `prod` stops the CLI, so a released CLI never
uses a development artifact.

Usage reports go to the production usage API only from a released CLI. In development
they go nowhere unless `CANYONOS_USAGE_URL` names one; `bun run cli:usage:dev` runs the
usage API locally and prints the value to export.

## Build the images

`bun run canyonos:dev` builds all three. To build one, run its command from the
workspace root:

```bash
docker build -f packages/core/Dockerfile -t canyonos-core:dev packages/core
docker build -f packages/api/Dockerfile -t canyonos-api:dev .
docker build -f packages/web/Dockerfile --target canyonos --build-arg VITE_API_URL=/api -t canyonos-web:dev .
```

- `local` uses the image Docker already has, so rebuild after changing the code behind
  it, such as anything under `packages/core/canyonos_core/`.
- Any other tag is pulled when Docker doesn't have it. `canyonos deploy` never builds
  CanyonOS's own images.
- The released images are tagged with the CLI's version. A checkout whose version was
  bumped but not released yet points at images that don't exist, so use `local` while
  developing.

## Run the dashboard with hot reload

To change the API or web code without rebuilding images, run the dashboard on the host.
In the dev shell:

```bash
canyonos deploy --serve false   # the workflow, without the dashboard's images
bun run dashboard:dev           # Postgres, then the API on :3000 and Vite on :5173
```

API and web edits reload while it runs. Core edits need `bun run canyonos:dev` and a
redeploy. To check the dashboard as users run it, deploy with the dashboard's images
instead.

**Send the workflow's telemetry to the host.** By default the Global Controller sends
it to the dashboard image's API, `http://canyonos-dashboard-api:3000`, which isn't
running. Set the workflow's
[`otel.destinations`](../guides/WORKFLOW_CONFIG.md#oteldestinations) to
`http://host.docker.internal:3000`.

**Register the project.** At start, the API registers only a project on the default
Redis that has no password. A deployed project's Redis has one, so register it while the
API runs, with the workflow's `redis.port`:

```bash
curl -X POST http://localhost:3000/canyonos/projects \
  -H 'Content-Type: application/json' \
  -d "{\"redis_port\":6379,\"redis_password\":\"$(cat ~/.canyonos/projects/<project>/redis_password)\"}"
```

The API stores the password encrypted, with a fixed development key unless
`REDIS_PASSWORD_ENCRYPTION_KEY` is set.

**Sign in.** How depends on `AUTH_MODE`, which is `none` unless `packages/api/.env`
sets it; copy that file from `packages/api/.env.example` to change it:

| `AUTH_MODE`                      | Sign-in                                           |
| -------------------------------- | ------------------------------------------------- |
| `none` (`.env.example`)          | None; the dashboard opens directly                |
| `password`                       | Create the first account on an empty database     |
| `password`, `SEED_DEV_DATA=true` | Also seeds `e2e@canyonos.test` / `e2e-password-1` |

Good to know:

- It uses the ports `3000` (API), `5173` (web) and `5432` (Postgres), next to the
  workflow's `8080` and `6379`. Free them, or change them, first.
- `scripts/dashboard-dev.ts` sets the local defaults: no deploy worker, and
  `127.0.0.1:6379` as the default Redis, the one read at start and for projects that
  never registered. A variable in your shell wins over them, and they win over
  `packages/api/.env` and `packages/web/.env`.
- Unlike `bun run docker:*`, it doesn't need `.docker/.env`: without it, Compose uses
  its default ports and volume.

## Run a checkout on an EC2 machine

From the dev shell, `canyonos provision` > **Provision AWS** asks whether the machine
runs **this checkout** or the official release. With this checkout, it:

1. Builds the Global Controller image here for `linux/amd64`, before anything is created
   in AWS. It's tagged `canyonos-core:dev-amd64`, so your own `canyonos-core:dev` is
   kept. On an Arm Mac, Docker emulates x86, so this takes a while.
2. Launches the machine with uv and rsync instead of the released CLI.
3. Once it has booted, copies the checkout to `~/canyonos` with rsync, without `.git`,
   `.venv`, `node_modules` or build output, and streams the image over SSH into the
   machine's Docker as `canyonos-core:dev`.
4. Installs the CLI from that copy with `uv tool install --editable`, with a
   `packages/cli/.env` that sets `CANYONOS_ENV=development` and
   `CANYONOS_CORE_IMAGE=local`.

Only the Global Controller image is shipped. The dashboard images and the skill are the
ones this version pins, so they must be released. On the machine, `canyonos -v` prints
`canyonos development`.

It needs `docker`, `rsync` and `ssh` here, and the private key of the key pair you
choose: a new one, `~/.ssh/<name>.pem`, or a path it asks for. To pick up later changes,
provision a new machine, or repeat steps 1 and 3 by hand.

## Kubernetes on kind

The same setup runs CanyonOS on a local Kubernetes cluster that behaves like the ones
customers run. On top of [Set up your environment](#set-up-your-environment), it needs:

- `kind` and `kubectl`: `brew install kind kubectl` on macOS,
  `winget install Kubernetes.kind Kubernetes.kubectl` on Windows;
- Docker with at least 4 CPUs and 8 GB of memory (Docker Desktop: Settings >
  Resources). Helm runs in a container.

```bash
scripts/kind/up.sh       # once: the cluster, its registry, and CanyonOS on it
bun run canyonos:dev     # every day: rebuilds the images, updates the cluster, opens the shell
```

In the dev shell, point a project at the cluster once, then use the commands as on
Docker:

```bash
canyonos target kubernetes   # namespace: the folder's name; registry: localhost:5001
canyonos deploy              # builds its images in the cluster, waits until ready
canyonos status              # its agents and replicas
canyonos test "hi"           # one query to the deployed project, and its result
canyonos logs                # the Global Controller's logs (or an agent's, or a replica's)
canyonos doctor              # the cluster, the operator, the project, its agents and endpoint
canyonos serve               # the dashboard, on http://127.0.0.1:8081
canyonos clean               # when done
```

The endpoint stays on `http://127.0.0.1:8080` and the dashboard on `8081`, through
port-forwards a background `canyonos` process holds open until `canyonos stop`.
`canyonos sync`, `stop --all` and `clean --all` work only on Docker, so deploy again
after a change. [Kubernetes deployment](../guides/KUBERNETES.md) has the other settings.

### What `up.sh` makes

1. A registry on `localhost:5001` that the nodes pull from.
2. A kind cluster with one control plane and one worker, Calico so NetworkPolicy is
   enforced, metrics-server, and Pod Security `restricted` in every namespace, as
   OpenShift does.
3. CanyonOS, through `scripts/kind/operator.sh`: the three images from this checkout
   and the operator's image, pushed to that registry, then the chart with the in-cluster
   builder and the dashboard. `up.sh` builds the images first if they are missing.

It's safe to re-run. The API server's Pod Security file is kept in `~/.canyonos/kind`,
so switching branches never stops the cluster from starting.

| Option                      | What it does                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `--version <version>`       | Installs a published release's chart and images from ghcr instead, as a customer would     |
| `--no-operator`             | Stops after the cluster and its registry                                                   |
| `--verify`                  | Checks the registry, Pod Security and NetworkPolicy                                        |
| `CANYONOS_KIND_WORKERS=<n>` | Worker nodes (default 1), set when the cluster is made; they share Docker's CPU and memory |
| `KIND_NODE_IMAGE=<image>`   | The Kubernetes version to run, to match a target cluster                                   |

`scripts/kind/down.sh` deletes the cluster; `--all` deletes the registry too.

### Update the cluster

`bun run canyonos:dev` updates the cluster too while it exists, so what changed rolls
out there and nothing else restarts. `scripts/kind/operator.sh` alone does the same
without opening the shell. Projects on the cluster pick up a new Core image on their
next deploy.

A released CLI makes the same cluster without a checkout: `canyonos cluster up`
installs its own release on it; see
[Set up the cluster](../guides/KUBERNETES.md#set-up-the-cluster). It carries its own
copy of `cluster.yaml`, `pod-security.yaml` and the versions pinned in `scripts/kind/`,
so change both together.

### When something is stuck

A deploy that waits with "no node to run on" needs more CPU or memory from Docker. To
look inside:

```bash
kubectl get pods -n my-project                                      # the project's pods
kubectl -n canyonos-system logs deploy/canyonos-controller-manager  # the operator's log
```
