# API

The dashboard's backend. It takes in the traces a running workflow sends, stores them in
Postgres, and serves them and each workflow's metrics to the dashboard. Built with Bun,
Elysia, and Drizzle.

On Docker it also serves `/v1/workflow-groups` (`src/modules/workflow-groups/`), the routes the
CLI deploys through: it keeps each workflow group's upload in the `workflow_groups` table and
runs its Global Controller container through the Docker socket in `DOCKER_SOCKET` (default
`/var/run/docker.sock`; empty, every `/v1/workflow-groups` route answers 503). With `CANYONOS_API_CONTAINER` set
to its own container's name (`canyonos serve` sets it), it connects that container to a workflow
group's Docker network, without taking its default gateway, before it reads that group's Redis.
Every route and its shapes are
at `/docs`, and the OpenAPI spec at `/docs/json`; `bun run sdk:generate` writes it to
`openapi.json` and regenerates the [SDK](../sdk/README.md).

On Kubernetes (`CANYONOS_TARGET=kubernetes`, as the operator's chart runs it) the same routes
run each workflow group on the cluster instead: a CanyonBuild, then its CanyonProject, through
the Kubernetes API with the pod's service account. There every `/v1/workflow-groups` route takes the caller's
Kubernetes token instead of the control key and checks it with a TokenReview and a
SubjectAccessReview. Core's commands run in the pod's `core` container, which takes them from a
queue in the `/workspace` folder both containers share. See
[Kubernetes](../../docs/guides/KUBERNETES.md#the-canyonos-api).

With `CANYONOS_API_KEY_HASH` set to the sha256 of the API key (64 lowercase hex characters),
every `/v1/workflows` and `/v1/resources` route needs that key as `Authorization: Bearer <key>`, and
answers 401 without it, before it reads anything else the request sends. So do a workflow's
`requests`, `metrics`, `monitoring`, `prompts`, `scaling`, `governance`, `history` and
`sample-data` routes, under
`/v1/workflow-groups/<workflow_group_id>/workflows/<workflow_id>/`. Unset or empty, those
routes are open; any other value refuses the start. Every other `/v1/workflow-groups` route
needs the control key in `~/.canyonos/control_key` instead, whose sha256 is
`CANYONOS_CONTROL_KEY_HASH`; without that hash, each of them is refused. The exception is
`POST /v1/workflow-groups/<workflow_group_id>/traces`, `/metrics` and `/logs`, where the
Global Controller sends the group's telemetry: they take no key. `GET /v1/auth/status` reports whether a key is needed, and
`GET /v1/auth/check` answers 200 to a request that carries it. See
[Authorization](../../docs/guides/AUTHORIZATION.md).

The API stores each workflow group's Redis password encrypted with `REDIS_PASSWORD_ENCRYPTION_KEY`.
Outside development and test it refuses to start without that key, at least 32 characters;
`canyonos serve` and the Helm chart make one and keep it.

The API listens before its database is ready, then connects, waiting while Postgres is down,
and migrates. Until then every route that reads the database answers 503 `database.unavailable`.
`GET /v1/healthz` answers 200 while the process serves, for a liveness probe. `GET /v1/readyz` answers
200 once the database is migrated and answers, and 503 otherwise; it also reports whether Docker
answers (a `/v1/workflow-groups` route answers 503 `docker.unavailable` when it doesn't). The CLI, the image's
`HEALTHCHECK` and the chart's readiness probe wait for it. Outside development and test, an unset
`DATABASE_URL` refuses the start, and a setup that fails after the database answered (a migration,
say) exits 1 so Docker or Kubernetes starts the API again. A database lost later answers 503
`database.unavailable` until the API reconnects. A request whose path has a `.` or `..` segment
answers 400. SIGTERM closes every connection, stops the background loops and the database, and
exits 0.

The dashboard reads each workflow from its workflow group's Redis (`src/modules/registry/`, the
keys in `registry.contract.ts`). On Docker `canyonos deploy` registers the workflow group with
`PUT /v1/workflow-groups/<workflow_group_id>/dashboard` as it creates the Global Controller
container, and the deploy fails if the API can't store it; on Kubernetes the operator lists the
workflow groups. When it starts and then every `WORKFLOWS_TICK_INTERVAL_MS` milliseconds (default
`60000`) the API visits the Redis of each
running workflow: it publishes the governed agents' spend and republishes the prompt versions
made live in the dashboard. A route on a workflow whose Redis it can't use answers a `registry.*`
error, such as `registry.workflow_not_running`, `registry.controller_unreachable` or
`registry.redis_auth_failed`.

To run it locally, see [DEVELOPMENT.md](../../docs/contributing/DEVELOPMENT.md).
