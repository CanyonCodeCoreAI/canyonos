# Local CanyonOS development

For when changing the CLI, Core, API, or web dashboard locally.

## Run it

```bash
bun install   # once
bun run canyonos:dev
```

That builds the Core, API and web images from this checkout, runs `uv sync`,
and opens a shell with the workspace `.venv` active. In that shell `canyonos`
is the CLI from this checkout and uses those local images. Type `exit` to
leave it. Rerun it after changing Core or dashboard code.

```bash
cd examples/portfolio
canyonos deploy
```

## Hot-reload dashboard

To iterate on the API or web code without rebuilding images, run the dashboard
on the host instead.

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

Inside the `bun run canyonos:dev` shell, deploy without the image-based
dashboard, then start the host dashboard from the checkout:

```bash
cd /path/to/workflow && canyonos deploy --serve false
cd /path/to/canyonos && bun run dashboard:dev
```

That command ensures local Postgres and Mailpit are running, then starts the
API at `http://localhost:3000` and Vite at `http://localhost:5173`. It uses
local defaults: fixed-code auth, no deploy worker, and Redis at
`127.0.0.1:6379`. Shell variables still win if you need different ports or
services.

`dashboard:dev` uses Compose defaults instead of the optional `.docker/.env`,
so this loop does not need another local env file. Use `.docker/.env` with the
`bun run docker:*` commands when you need custom backing-service ports or
volumes.

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
deploy, restart `bun run dashboard:dev` so it bootstraps the new project.
- API and web edits reload while the command is running. Core edits need
`bun run canyonos:dev` again and a workflow redeploy.
- The default ports are API `3000`, web `5173`, Postgres `5432`, Mailpit `1025`
and `8025`, workflow `8080`, and workflow Redis `6379`. Stop or reconfigure
anything already using one of them.
- This is the fast host-dashboard loop. Use `canyonos deploy` with the image
dashboard when testing container parity.

