# Development

For when changing the CLI, Core, API, or web dashboard locally. Prerequisites
and the checks to run before a pull request are in
[CONTRIBUTING.md](https://github.com/CanyonCodeCoreAI/canyonos/blob/main/CONTRIBUTING.md).

The commands are the same in development and production. The only differences
are where the binary runs from and an optional `packages/cli/.env`:

|  | Development | Open Source |
| --- | --- | --- |
| How it runs | `canyonos deploy` inside `bun run canyonos:dev`, or `uv run canyonos deploy` | `canyonos deploy` |
| Environment | `development` via `packages/cli/.env` (copied once from `packages/cli/.env.example`, gitignored) | `production` by default, no `.env` |
| Core image | `canyonos-core:dev` local | `ghcr.io/…/canyonos-core:<version>` |
| Skill | `skills/converting-to-canyonos` from the checkout | downloaded from `main` |

## Set up your environment

```bash
bun install   # once
bun run canyonos:dev
```

That builds the Core, API and web images from this checkout, creates `packages/cli/.env` from `packages/cli/.env.example` if it is missing, runs `uv sync`, and opens a shell with the workspace `.venv` active. In that shell `canyonos` is the CLI from this checkout and uses those local images: `canyonos -v` prints `canyonos development` instead of a version number. Type `exit` to leave it.

Rerun `bun run canyonos:dev` it after changing any code in core or the dashboard (api, ui, web)

### Run it

```bash
cd examples/portfolio # any workflow from examples works though
canyonos deploy
```

The file's location is fixed. The CLI always looks for .env in packages/cli/, next to its own code. It doesn't look in whatever folder you're in when you run it. So if you cd examples/portfolio and run canyonos deploy, it still uses packages/cli/.env. A .env inside examples/portfolio would be ignored for switching environments.

A variable already set in your shell wins over the file, so `export CANYONOS_CORE_IMAGE=prod` would use prod, even if you are in a local environment

### The environment

`CANYONOS_ENV` can be: `development`, or `production`; unset or empty means `production`. Anything else fails at startup. `canyonos/env.py` is the only module that reads the environment: it resolves each artifact once and everything else imports the result.

Every artifact variable takes the same three forms:

| Value           | Meaning                                                                |
| --------------- | ---------------------------------------------------------------------- |
| unset or `prod` | the production artifact, i.e. exactly what a released CLI uses         |
| `local`         | the artifact from this checkout                                        |
| anything else   | taken literally: an image tag, a directory, or a git ref for the skill |

Artifacts are independent, so "core from my checkout, skill from `main`" and the
reverse are both fine. Outside `production` overrides are allowed; in
`production` anything but unset/`prod` raises, so a released CLI can never be
talked into a dev artifact.

| Variable | `local` resolves to |
|---|---|
| `CANYONOS_CORE_IMAGE` | `canyonos-core:dev` |
| `CANYONOS_SKILL_SOURCE` | `<workspace root>/skills/converting-to-canyonos` |
| `CANYONOS_API_IMAGE` | `canyonos-api:dev` |
| `CANYONOS_WEB_IMAGE` | `canyonos-web:dev` |

## Building the core image

`CANYONOS_CORE_IMAGE=local` expects an image the daemon already has, so build it
after changing anything under `packages/core/canyonos_core/`.
`bun run canyonos:dev` does that along with the dashboard images; to build only
this one, the build context is the core package:

```bash
docker build -f packages/core/Dockerfile -t canyonos-core:dev packages/core
```

A literal image tag is pulled if the daemon doesn't have it; `deploy` never
builds images. The production images are always pulled, exactly as a released
CLI does: every release publishes the core, api, and web images under the CLI's
own version, and `canyonos/env.py` derives their references from it. A checkout
whose version was bumped but not released yet points at images that do not
exist, so use `local` while developing.

## Run a checkout on an EC2 machine

From the dev shell, `canyonos provision` → **Provision AWS** asks whether the machine runs
**this checkout** or the official release. Choosing the checkout:

1. Builds the Global Controller image here for `linux/amd64`, tagged
   `canyonos-core:dev-amd64` so your own `canyonos-core:dev` is kept. This
   happens before anything is created in AWS. On an Arm Mac Docker emulates x86,
   so it takes a while.
2. Launches the machine with uv and rsync instead of the released CLI.
3. Once it has booted, copies the checkout to `~/canyonos` with rsync (no
   `.git`, `.venv`, `node_modules` or build output), streams the image over SSH
   with `docker save | docker load`, and tags it `canyonos-core:dev` there.
4. Installs the CLI from the copy with `uv tool install --editable`, with a
   `packages/cli/.env` that sets `CANYONOS_ENV=development` and
   `CANYONOS_CORE_IMAGE=local`. The dashboard images and the skill are the ones
   this version pins, so they must be released.

Provisioning needs `docker`, `rsync` and `ssh` here, Docker running, and the private
key of the key pair you choose: a new one, `~/.ssh/<name>.pem`, or a path it
asks for. On the machine, `canyonos -v` prints `canyonos development`.

To pick up later changes, rerun `canyonos provision` for a new machine, or repeat
steps 1 and 3 by hand.

## Hot-reload dashboard

To iterate on the API or web code without rebuilding images, run the dashboard
on the host instead.

The workflow's `otel.destinations` must point at `http://host.docker.internal:3000`
(see [global_controller.yaml](../guides/GLOBAL_CONTROLLER.md#oteldestinations));
`examples/portfolio` already does.

Inside the `bun run canyonos:dev` shell, deploy without the image-based
dashboard, then start the host dashboard from the checkout:

```bash
canyonos deploy --serve false
bun run dashboard:dev
```

That command ensures local Postgres is running, then starts the API at
`http://localhost:3000` and Vite at `http://localhost:5173`. It uses local
defaults: no deploy worker and `127.0.0.1:6379` as the default workflow Redis.
The defaults are in `scripts/dashboard-dev.ts`. A variable set in your shell
wins over them, but they win over the same variables in `packages/api/.env`
and `packages/web/.env`.

`packages/api/.env.example` sets `AUTH_MODE=none`, so the dashboard opens with
no sign-in. With `AUTH_MODE=password` it asks you to create the first account
on an empty database; `SEED_DEV_DATA=true` also seeds `e2e@canyonos.test` /
`e2e-password-1` to sign in with.

Unlike the `bun run docker:*` commands, `dashboard:dev` does not require
`.docker/.env`: without it Compose uses its default ports and volume, and it
still reads the file when you have one.

Query the workflow normally. For example:

```bash
curl -X POST http://127.0.0.1:8080/main \
  -H 'Content-Type: application/json' \
  -d '{"query":"your query"}'
```

Then poll `http://127.0.0.1:8080/status/<request_id>`. Agent containers
send their traces to the host API, and the Vite dashboard shows them.

### A few quirks

- The API registers the project it finds on the default Redis during startup.
  After a new deploy, restart `bun run dashboard:dev`, or register the project
  while it runs with `curl -X POST http://localhost:3000/canyonos/projects
-H 'Content-Type: application/json' -d '{"redis_port":6379}'`.
- API and web edits reload while the command is running. Core edits need
  `bun run canyonos:dev` again and a workflow redeploy.
- The default ports are API `3000`, web `5173`, Postgres `5432`, endpoint
  `8080`, and workflow Redis `6379`. Stop or reconfigure
  anything already using one of them. The workflow ports are the `endpoint.api_port`
  and `redis.port` defaults of its config; if it declares another `redis.port`,
  register it with that port. `CANYONOS_REDIS_PORT` is only the default Redis:
  the one read at startup and for projects that never registered.
- This is the fast host-dashboard loop. Use `canyonos deploy` with the image
  dashboard when testing container parity.

## Kubernetes on kind

The same development setup runs CanyonOS on a local Kubernetes cluster that behaves
like the ones customers run. On top of [Set up your environment](#set-up-your-environment)
it needs [`kind`](https://kind.sigs.k8s.io/docs/user/quick-start/#installation) and
[`kubectl`](https://kubernetes.io/docs/tasks/tools/) (macOS: `brew install kind kubectl`;
Windows: `winget install Kubernetes.kind Kubernetes.kubectl`, and run the scripts in Git
Bash), and Docker with at least 4 CPUs and 8 GB (Docker Desktop: Settings > Resources).
Helm runs in a container.

```bash
scripts/kind/up.sh       # once: CanyonOS's images if missing, the cluster, its registry, CanyonOS on it
bun run canyonos:dev     # as every day: rebuilds the images, updates CanyonOS on the cluster, opens the dev shell
```

In the dev shell, deploy a project as on Docker, with `--target kubernetes`. Add to its
`config/global_controller.yaml`:

```yaml
kubernetes:
  namespace: my-project        # created if missing
  registry: localhost:5001
```

```bash
canyonos deploy --target kubernetes       # builds its images in the cluster, waits until ready
canyonos status --target kubernetes       # its agents and replicas
canyonos logs --target kubernetes         # the global controller's logs (or: an agent, a replica)
canyonos serve --target kubernetes        # the dashboard, on http://127.0.0.1:8081
canyonos clean --target kubernetes        # when done; scripts/kind/down.sh removes the cluster
```

The deploy prints how to call the endpoint, through a `kubectl port-forward`. `canyonos
test` and `sync`, and `stop --all` or `clean --all`, are Docker's only: send a request
through the port-forward, and deploy again after a change. See
[Kubernetes deployment](../guides/KUBERNETES.md) for the `kubernetes:` section's other
settings.

`up.sh` makes, in order:

1. a registry on `localhost:5001` that the nodes pull from;
2. a kind cluster with one control plane and one worker (`CANYONOS_KIND_WORKERS=3` for
   more, when it is made: nodes share Docker's CPU and memory, so more of them only
   let a project spread its pods), Calico so NetworkPolicy is enforced, metrics-server,
   and Pod Security `restricted` in every namespace, as OpenShift does;
3. CanyonOS (`scripts/kind/operator.sh`): the `canyonos-core:dev`, `canyonos-api:dev`
   and `canyonos-web:dev` images `bun run canyonos:dev` built, and the operator's image
   built there, pushed to that registry, then the chart with the in-cluster builder and
   the dashboard. The cluster runs the same core image `CANYONOS_CORE_IMAGE=local`
   deploys.

After changing CanyonOS, `bun run canyonos:dev` as usual: while the cluster exists it
runs `scripts/kind/operator.sh` too, so what changed rolls out there and the rest
restarts nothing (run `operator.sh` alone to update the cluster without the shell).
Projects deployed to the cluster pick up a new core image on their next deploy. It is
all safe to re-run. `up.sh --no-operator` stops after the cluster, and `--verify` checks the
cluster's pieces. The API server's Pod Security file is kept in `~/.canyonos/kind`, so
a branch switch never stops the cluster from starting. `scripts/kind/down.sh` deletes
the cluster (`--all` the registry too).

When a deploy waits with "no node to run on", Docker has too little CPU or memory for
it. `kubectl get pods -n my-project` shows the project's pods, and
`kubectl -n canyonos-system logs deploy/canyonos-controller-manager` the operator's log.

```bash
scripts/kind/e2e.sh
```

`e2e.sh` is the whole path, and what CI runs (`Kubernetes E2E`) for changes to the
operator, the chart, or the Kubernetes parts of core, the CLI and the API. It builds
the images with `bun run canyonos:dev --images-only`, installs them (`operator.sh`), and
deploys `examples/helloworld` with the real CLI as a user who may only edit one
namespace. It then checks requests, the dashboard, a Redis password rotation, `stop`
and `clean`. Everything but the image builds runs in a container on the kind network,
so it runs the same on any OS.

For the operator alone, `make manifests generate fmt vet test lint` in
`packages/operator` (in the `golang:1.27.0` container) runs its unit and envtest suites.

## Tests

Every suite runs from the workspace root through Turborepo:

```bash
bun run test
```

`bun run check` runs lint, type checks and the format check the same way.

The end-to-end suites are separate from `bun run test`. Each needs the local
env files first:

```bash
cp .docker/.env.example .docker/.env
cp packages/api/.env.example packages/api/.env
cp packages/api/.env.test.example packages/api/.env.test
cp packages/web/.env.example packages/web/.env
```

| Suite     | Command                | Needs                                                                                                                               |
| --------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| API       | `bun run api:test:e2e` | Postgres (`bun run docker:up`); resets the `canyonos_test` database                                                                 |
| Dashboard | `bun run ui:test:e2e`  | Chromium (`bunx playwright install chromium`); starts Postgres, the API and Vite itself, or reuses ones already running             |
| Workflow  | `tests/run_tests.sh`   | Run inside the `bun run canyonos:dev` shell; deploys `examples/helloworld` to port `8082`, then runs the integration and load tests |
| Kubernetes | `scripts/kind/e2e.sh` | The kind cluster from `scripts/kind/up.sh`; see [Kubernetes on kind](#kubernetes-on-kind) |

`tests/README.md` covers running the workflow tests against a stack that is
already deployed.
