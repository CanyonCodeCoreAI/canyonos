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
| Skill | `.claude/skills/porting-to-canyonos` from the checkout | downloaded from `main` |

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

| Value | Meaning |
|---|---|
| unset or `prod` | the production artifact, i.e. exactly what a released CLI uses |
| `local` | the artifact from this checkout |
| anything else | taken literally: an image tag, a directory, or a git ref for the skill |

Artifacts are independent, so "core from my checkout, skill from `main`" and the
reverse are both fine. Outside `production` overrides are allowed; in
`production` anything but unset/`prod` raises, so a released CLI can never be
talked into a dev artifact.

| Variable | `local` resolves to |
|---|---|
| `CANYONOS_CORE_IMAGE` | `canyonos-core:dev` |
| `CANYONOS_SKILL_SOURCE` | `<workspace root>/.claude/skills/porting-to-canyonos` |
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

That command ensures local Postgres and Mailpit are running, then starts the
API at `http://localhost:3000` and Vite at `http://localhost:5173`. It uses
local defaults: fixed-code auth, no deploy worker, and the workflow's Redis at
`127.0.0.1:6379`. The defaults are in `scripts/dashboard-dev.ts`. A variable
set in your shell wins over them, but they win over the same variables in
`packages/api/.env` and `packages/web/.env`.

Unlike the `bun run docker:*` commands, `dashboard:dev` does not require
`.docker/.env`: without it Compose uses its default ports and volume, and it
still reads the file when you have one.

Query the workflow normally. For example:

```bash
curl -X POST http://127.0.0.1:8080/main \
  -H 'Content-Type: application/json' \
  -d '{"query":"your query"}'
```

Then poll `http://127.0.0.1:8080/status/<request_id>`. Workflow containers
send their traces to the host API, and the Vite dashboard shows them.

### A few quirks

- The API reads the workflow identity from Redis during startup. After a new
deploy, restart `bun run dashboard:dev` so it bootstraps the new project.
- API and web edits reload while the command is running. Core edits need
`bun run canyonos:dev` again and a workflow redeploy.
- The default ports are API `3000`, web `5173`, Postgres `5432`, Mailpit `1025`
and `8025`, workflow `8080`, and workflow Redis `6379`. Stop or reconfigure
anything already using one of them. The workflow ports are the `api_port` and
`redis_port` defaults of its config; if it declares another `redis_port`, run
`dashboard:dev` with `CANYONOS_REDIS_PORT` set to it.
- This is the fast host-dashboard loop. Use `canyonos deploy` with the image
dashboard when testing container parity.

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

| Suite | Command | Needs |
|---|---|---|
| API | `bun run api:test:e2e` | Postgres and Mailpit (`bun run docker:up`); resets the `canyonos_test` database |
| Dashboard | `bun run ui:test:e2e` | Chromium (`bunx playwright install chromium`); starts Postgres, the API and Vite itself, or reuses ones already running |
| Workflow | `tests/run_tests.sh` | Run inside the `bun run canyonos:dev` shell; deploys `examples/helloworld` to port `8080`, then runs the integration and load tests |

`tests/README.md` covers running the workflow tests against a stack that is
already deployed.
