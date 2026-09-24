# Local CanyonOS development

Use this loop when changing the CLI, API, or web dashboard locally. It keeps
the workflow/Core in Docker, but runs the dashboard API and Vite on the host
with watch mode and hot reload.

## One-time setup

```bash
cd /path/to/canyonos
bun install
uv sync
```

Build the Core image whenever Core code changes:

```bash
docker build -f packages/core/Dockerfile -t canyonos-core:dev packages/core
```

In the workflow project, configure its OTEL destination in
`.car/config/global_controller.yaml`. This is a base endpoint: do not add
`/v1/traces`.

```yaml
otel:
  destinations:
    - name: local
      protocol: http
      endpoint: http://host.docker.internal:3000
      headers: {}
```

## Run it

Deploy the workflow without the image-based dashboard:

```bash
cd /path/to/workflow
CANYONOS_ENV=development CANYONOS_CORE_IMAGE=local \
  /path/to/canyonos/.venv/bin/canyonos deploy --serve false
```

Then, from the CanyonOS checkout, start the host dashboard:

```bash
cd /path/to/canyonos
bun run canyonos:dev
```

That command ensures local Postgres and Mailpit are running, then starts the
API at `http://localhost:3000` and Vite at `http://localhost:5173`. It uses
local defaults: fixed-code auth, no deploy worker, and Redis at
`127.0.0.1:6379`. Shell variables still win if you need different ports or
services.

Query the workflow normally. For example:

```bash
curl -X POST http://127.0.0.1:8080/main \
  -H 'Content-Type: application/json' \
  -d '{"query":"your query"}'
```

Then poll `http://127.0.0.1:8080/status/<request_id>`. Workflow containers
send their traces to the host API, and the Vite dashboard shows them.

## A few quirks

- The API reads the workflow identity from Redis during startup. After a new
  deploy, restart `bun run canyonos:dev` so it bootstraps the new project.
- API and web edits reload while the command is running. Core edits need the
  Core image rebuild and a workflow redeploy.
- The default ports are API `3000`, web `5173`, Postgres `5432`, Mailpit `1025`
  and `8025`, workflow `8080`, and workflow Redis `6379`. Stop or reconfigure
  anything already using one of them.
- This is the fast host-dashboard loop. It intentionally does not build the
  API or web images. Use the image build flow when testing container parity.
