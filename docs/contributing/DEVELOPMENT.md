# Development

How to run the CLI, Core and dashboard from a checkout, build their images, and run the
tests, on Docker, an EC2 machine or a local Kubernetes cluster. The repository layout
and the checks a pull request must pass are in
[CONTRIBUTING.md](https://github.com/CanyonCodeCoreAI/canyonos/blob/main/CONTRIBUTING.md).

## Prerequisites

| Tool                                                                                                                     | Version          | Needed for                                                     |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------- | -------------------------------------------------------------- |
| [uv](https://docs.astral.sh/uv/)                                                                                         | 0.12.15 or later | The Python workspace (Core and CLI)                            |
| [Bun](https://bun.sh/)                                                                                                   | 1.3.1 or later   | The TypeScript workspace and the scripts                       |
| Docker, running                                                                                                          | any              | Building images and every deploy                               |
| [kind](https://kind.sigs.k8s.io/docs/user/quick-start/#installation), [kubectl](https://kubernetes.io/docs/tasks/tools/) | any              | [Kubernetes on kind](#kubernetes-on-kind)                      |
| `rsync`, `ssh`                                                                                                           | any              | [Running a checkout on EC2](#run-a-checkout-on-an-ec2-machine) |
| Git Bash (Windows)                                                                                                       | any              | The shell scripts in `scripts/` and `tests/`                   |

## Set up your environment

1. Clone the repository and install both workspaces:

   ```bash
   git clone https://github.com/CanyonCodeCoreAI/canyonos.git
   cd canyonos
   uv sync
   bun install
   ```

2. Open the dev shell:

   ```bash
   bun run canyonos:dev
   ```

   It builds the Core, API and web images from this checkout, creates
   `packages/cli/.env` from `packages/cli/.env.example` if it is missing, runs
   `uv sync`, bundles the starter workflows, and opens a shell with the workspace
   `.venv` active. When the [kind cluster](#kubernetes-on-kind) exists, it updates
   CanyonOS there too.

3. Check that `canyonos` is the CLI from this checkout:

   ```bash
   canyonos -v   # prints "canyonos development" instead of a version number
   ```

Type `exit` to leave the shell. Run `bun run canyonos:dev` again after changing any code
in Core or the dashboard (API, UI, web), so the images match the code.

The commands are the same in development and in a released CLI. What differs is where
the CLI runs from and what it deploys:

|             | Development                                                        | Released CLI                                            |
| ----------- | ------------------------------------------------------------------ | ------------------------------------------------------- |
| How it runs | `canyonos` in the dev shell, or `uv run canyonos` in the workspace | `canyonos`                                              |
| Environment | `development`, from `packages/cli/.env` (gitignored)               | `production`, with no `.env`                            |
| Core image  | `canyonos-core:dev`, built locally                                 | `ghcr.io/canyoncodecoreai/canyonos-core:<version>`      |
| Dashboard   | `canyonos-api:dev` and `canyonos-web:dev`, built locally           | `ghcr.io/canyoncodecoreai/canyonos-{api,web}:<version>` |
| Skill       | `skills/converting-to-canyonos` in this checkout                   | Fetched from the GitHub tag `v<version>`                |

## Run the CLI from a checkout

In the dev shell, `canyonos` works from any folder. Deploy a copy of an example, since a
deploy writes a `project_id` and default resources into the project's
`config/workflow_config.yaml`:

```bash
cp -R examples/helloworld ../helloworld   # needs no LLM and no API keys
cd ../helloworld
canyonos deploy
canyonos test "hi"
```

The CLI always reads its `.env` from `packages/cli/`, next to its own code, not from
the folder you run it in. A `.env` in the project folder belongs to the project: it
does not switch the CLI's environment. A variable already set in your shell wins over
the file, so `export CANYONOS_CORE_IMAGE=prod` deploys the production image even in
development.

### Environment variables

`packages/cli/canyonos/env.py` is the only module that reads the environment. It
resolves each setting once, and everything else imports the result.

`CANYONOS_ENV` selects the environment:

| Value                        | Meaning                                                  |
| ---------------------------- | -------------------------------------------------------- |
| unset or empty, `production` | What a released CLI runs; no overrides allowed           |
| `development`                | Overrides allowed; `packages/cli/.env.example` sets this |
| `test`                       | As `development`; the CLI end-to-end tests set it        |

Anything else fails at startup. Each artifact variable takes the same three forms:

| Value           | Meaning                                                                |
| --------------- | ---------------------------------------------------------------------- |
| unset or `prod` | The production artifact, exactly what a released CLI uses              |
| `local`         | The artifact from this checkout                                        |
| anything else   | Taken literally: an image tag, a directory, or a git ref for the skill |

| Variable                | `local` resolves to                              |
| ----------------------- | ------------------------------------------------ |
| `CANYONOS_CORE_IMAGE`   | `canyonos-core:dev`                              |
| `CANYONOS_API_IMAGE`    | `canyonos-api:dev`                               |
| `CANYONOS_WEB_IMAGE`    | `canyonos-web:dev`                               |
| `CANYONOS_SKILL_SOURCE` | `<workspace root>/skills/converting-to-canyonos` |

Artifacts are independent, so "Core from my checkout, skill from `main`" and the
reverse are both fine. In `production`, any value but unset or `prod` raises an error,
so a released CLI can never be talked into a development artifact.

Usage reporting goes to the production usage API only from a released CLI. In
development, it goes nowhere unless `CANYONOS_USAGE_URL` names one: `bun run
cli:usage:dev` runs the usage API locally and prints the value to export.

## Build the images

`bun run canyonos:dev` builds all three images. To build one, run its command from the
workspace root:

```bash
docker build -f packages/core/Dockerfile -t canyonos-core:dev packages/core
docker build -f packages/api/Dockerfile -t canyonos-api:dev .
docker build -f packages/web/Dockerfile --target canyonos --build-arg VITE_API_URL=/api -t canyonos-web:dev .
```

`local` expects an image the Docker daemon already has, so rebuild after changing the
code behind it, such as anything under `packages/core/canyonos_core/`. A literal image
tag is pulled if the daemon doesn't have it; `canyonos deploy` never builds CanyonOS's
images.

The production images are always pulled, exactly as a released CLI does. Every release
publishes the Core, API and web images under the CLI's own version, and `env.py`
derives their references from it. A checkout whose version was bumped but not released
yet points at images that do not exist, so use `local` while developing.

## Run the dashboard with hot reload

To iterate on the API or web code without rebuilding images, run the dashboard on the
host. Inside the dev shell, deploy without the image-based dashboard, then start the
dashboard from the checkout:

```bash
canyonos deploy --serve false
bun run dashboard:dev
```

`dashboard:dev` makes sure local Postgres is running, then starts the API at
`http://localhost:3000` and Vite at `http://localhost:5173`. API and web edits reload
while it runs; Core edits need `bun run canyonos:dev` again and a redeploy.

By default the Global Controller sends telemetry to the dashboard API's container,
`http://canyonos-dashboard-api:3000`, which isn't running here. For the host API to
get it, set the workflow's `otel.destinations` to `http://host.docker.internal:3000`
(see [Workflow config](../guides/WORKFLOW_CONFIG.md#oteldestinations)).

The local defaults are in `scripts/dashboard-dev.ts`: no deploy worker, and
`127.0.0.1:6379` as the default workflow Redis. A variable set in your shell wins over
them, but they win over the same variables in `packages/api/.env` and
`packages/web/.env`. Unlike the `bun run docker:*` commands, `dashboard:dev` does not
require `.docker/.env`: without it, Compose uses its default ports and volume.

Sign-in depends on `AUTH_MODE` in `packages/api/.env`:

| `AUTH_MODE`                      | Sign-in                                           |
| -------------------------------- | ------------------------------------------------- |
| `none` (`.env.example`)          | None; the dashboard opens directly                |
| `password`                       | Create the first account on an empty database     |
| `password`, `SEED_DEV_DATA=true` | Also seeds `e2e@canyonos.test` / `e2e-password-1` |

Query the workflow as usual, then poll `http://127.0.0.1:8080/status/<request_id>`:

```bash
curl -X POST http://127.0.0.1:8080/main \
  -H 'Content-Type: application/json' \
  -d '{"query":"your query"}'
```

Agent containers send their traces to the host API, and the Vite dashboard shows them.

Things to know:

- The API registers the project it finds on the default Redis when it starts, if that
  Redis has no password. A deployed project's Redis has one, so after a deploy register
  the project while the API runs:

  ```bash
  curl -X POST http://localhost:3000/canyonos/projects \
    -H 'Content-Type: application/json' \
    -d "{\"redis_port\":6379,\"redis_password\":\"$(cat ~/.canyonos/projects/<project>/redis_password)\"}"
  ```

  The API stores that password encrypted with a fixed development key unless
  `REDIS_PASSWORD_ENCRYPTION_KEY` is set.

- The default ports are API `3000`, web `5173`, Postgres `5432`, endpoint `8080` and
  workflow Redis `6379`. Stop or reconfigure anything already using one of them.
- The workflow ports are the `endpoint.api_port` and `redis.port` of its config. If it
  declares another `redis.port`, register it with that port. `CANYONOS_REDIS_PORT` sets
  only the default Redis: the one read at startup and for projects that never
  registered.
- To test container parity, use `canyonos deploy` with the image dashboard instead.

## Run a checkout on an EC2 machine

From the dev shell, `canyonos provision` > **Provision AWS** asks whether the machine
runs **this checkout** or the official release. Choosing the checkout:

1. Builds the Global Controller image here for `linux/amd64`, tagged
   `canyonos-core:dev-amd64` so your own `canyonos-core:dev` is kept. This happens
   before anything is created in AWS. On an Arm Mac, Docker emulates x86, so it takes a
   while.
2. Launches the machine with uv and rsync instead of the released CLI.
3. Once it has booted, copies the checkout to `~/canyonos` with rsync (without `.git`,
   `.venv`, `node_modules` or build output), streams the image over SSH into the
   machine's Docker, and tags it `canyonos-core:dev` there.
4. Installs the CLI from the copy with `uv tool install --editable`, with a
   `packages/cli/.env` that sets `CANYONOS_ENV=development` and
   `CANYONOS_CORE_IMAGE=local`.

Only the Global Controller image is shipped: the dashboard images and the skill are the
ones this version pins, so they must be released. On the EC2 machine, `canyonos -v`
prints `canyonos development`.

Provisioning needs `docker`, `rsync` and `ssh` on this machine, Docker running, and the
private key of the key pair you choose: a new one, `~/.ssh/<name>.pem`, or a path it
asks for. To pick up later changes, rerun `canyonos provision` for a new machine, or
repeat steps 1 and 3 by hand.

## Kubernetes on kind

The same development setup runs CanyonOS on a local Kubernetes cluster that behaves like
the ones customers run. On top of [Set up your environment](#set-up-your-environment),
it needs `kind` and `kubectl` (macOS: `brew install kind kubectl`; Windows:
`winget install Kubernetes.kind Kubernetes.kubectl`, and run the scripts in Git Bash),
and Docker with at least 4 CPUs and 8 GB of memory (Docker Desktop: Settings >
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

`canyonos deploy` keeps the endpoint on `http://127.0.0.1:8080`, and `canyonos serve`
keeps the dashboard on `8081`, each through a port-forward that a background `canyonos`
process holds open until `canyonos stop`. `canyonos sync`, `stop --all` and
`clean --all` work only on Docker: deploy again after a change. See
[Kubernetes deployment](../guides/KUBERNETES.md) for the other settings of the
`kubernetes:` section.

### What `up.sh` makes

1. A registry on `localhost:5001` that the nodes pull from.
2. A kind cluster with one control plane and one worker, Calico so NetworkPolicy is
   enforced, metrics-server, and Pod Security `restricted` in every namespace, as
   OpenShift does.
3. CanyonOS (`scripts/kind/operator.sh`): the `canyonos-core:dev`, `canyonos-api:dev`
   and `canyonos-web:dev` images, and the operator's image built there, pushed to that
   registry, then the chart with the in-cluster builder and the dashboard. If the
   images are missing, `up.sh` builds them first. The cluster runs the same Core image
   that `CANYONOS_CORE_IMAGE=local` deploys.

It is all safe to re-run. The API server's Pod Security file is kept in
`~/.canyonos/kind`, so a branch switch never stops the cluster from starting.

| Option                      | What it does                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `--version <version>`       | Installs a published release's chart and images from ghcr instead, as a customer would     |
| `--no-operator`             | Stops after the cluster and its registry                                                   |
| `--verify`                  | Checks the registry, Pod Security and NetworkPolicy                                        |
| `CANYONOS_KIND_WORKERS=<n>` | Worker nodes (default 1), set when the cluster is made; they share Docker's CPU and memory |
| `KIND_NODE_IMAGE=<image>`   | The Kubernetes version to run, to match a target cluster                                   |

`scripts/kind/down.sh` deletes the cluster; `--all` deletes the registry too.

### Update the cluster

After changing CanyonOS, run `bun run canyonos:dev` as usual. While the cluster exists,
it runs `scripts/kind/operator.sh` too, so what changed rolls out there and nothing else
restarts. Run `operator.sh` alone to update the cluster without opening the shell.
Projects deployed to the cluster pick up a new Core image on their next deploy.

A released CLI makes the same cluster without a checkout: `canyonos cluster up` installs
the CLI's own release on it (see
[Set up the cluster](../guides/KUBERNETES.md#set-up-the-cluster)). It carries its own
copy of `cluster.yaml`, `pod-security.yaml` and the versions pinned in
`scripts/kind/`, so change both together.

### When something is stuck

When a deploy waits with "no node to run on", Docker has too little CPU or memory for
it. To look inside:

```bash
kubectl get pods -n my-project                                      # the project's pods
kubectl -n canyonos-system logs deploy/canyonos-controller-manager  # the operator's log
```

### Kubernetes tests

```bash
scripts/kind/e2e.sh
```

`e2e.sh` tests the whole path. CI runs it (`Kubernetes E2E`) on each pull request, and
on `main`, for changes to Core, the CLI, the API, the operator (the chart included) or
`scripts/kind`. It builds the images with `bun run canyonos:dev --images-only`, installs
them (`operator.sh`), and deploys `examples/helloworld` with the real CLI as a user who
may only edit one namespace. It then checks requests, the dashboard, a Redis password
rotation, `stop` and `clean`. Everything but the image builds runs in a container on the
kind network, so it runs the same on any OS.

For the operator alone, run its unit and envtest suites in `packages/operator`, in the
`golang:1.27.0` container, as CI does:

```bash
make manifests generate fmt vet test lint
```

## Tests

The lint, type and format checks run from the workspace root through Turborepo:

```bash
bun run check
```

The tests are end to end; there are no unit suites. Add or update the E2E test at the
boundary a change touches. The API and dashboard suites need the local env files
first:

```bash
cp .docker/.env.example .docker/.env
cp packages/api/.env.example packages/api/.env
cp packages/api/.env.test.example packages/api/.env.test
cp packages/web/.env.example packages/web/.env
```

| Suite                | Command                                                        | Needs                                                                                                                                                             |
| -------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API end-to-end       | `bun run api:test:e2e`                                         | Postgres (`bun run docker:up`); resets the `canyonos_test` database                                                                                               |
| Dashboard end-to-end | `bun run ui:test:e2e`                                          | Chromium (`bunx playwright install chromium`); starts Postgres, the API and Vite, or reuses running ones                                                          |
| CLI end-to-end       | `bun run cli:test:e2e`                                         | Linux or macOS, and a Core image for the deploy case; see `packages/cli/tests/e2e/README.md`                                                                      |
| Deploy               | `uv run pytest tests/e2e/cases --project=helloworld`           | Docker; builds the images from this checkout, deploys the project and runs the E2E cases against it                                                               |
| Deploy scenarios     | `uv run pytest tests/e2e/scenarios`                            | Docker; checks `canyonos validate`, the `canyonos new-app` starter, two projects on one dashboard and the governance rules; the governance one needs the AWS keys |
| EC2 pool             | `tests/e2e/ec2_pool.sh`                                        | AWS access to run machines; manual, no workflow runs it                                                                                                           |
| Dashboard images     | `bun run canyonos:smoke`                                       | The images in `CANYONOS_API_IMAGE` and `CANYONOS_WEB_IMAGE` (default `canyonos-api:smoke`, `canyonos-web:smoke`)                                                  |
| CLI usage API        | `bun run cli:usage:test:e2e`, `bun run cli:usage:test:cli-e2e` | Docker; each starts its own moto server                                                                                                                           |
| Kubernetes           | `scripts/kind/e2e.sh`                                          | The kind cluster; see [Kubernetes tests](#kubernetes-tests)                                                                                                       |
| Operator             | `make manifests generate fmt vet test lint`                    | The `golang:1.27.0` container, in `packages/operator`; runs its envtest integration suite                                                                         |

[`tests/e2e/README.md`](https://github.com/CanyonCodeCoreAI/canyonos/blob/main/tests/e2e/README.md)
lists the projects, their secrets and how to add a case.

## Preview the docs

The docs are built with MkDocs from `docs/`, as configured in `mkdocs.yml`, with the
versions pinned in `docs/requirements.txt`. Read the Docs fails the build on any
warning, so build with `--strict` before a docs change:

```bash
uv run --no-project --with-requirements docs/requirements.txt mkdocs build --strict
uv run --no-project --with-requirements docs/requirements.txt mkdocs serve
```

`mkdocs serve` shows the site on `http://127.0.0.1:8000` and rebuilds it on each save.
For how to write them, see [Style](STYLE.md).
