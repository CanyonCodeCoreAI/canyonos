# API

The dashboard's backend. It takes in the traces a running workflow sends, stores them in
Postgres, and serves them and each workflow's metrics to the dashboard. Built with Bun,
Elysia, and Drizzle.

On Docker it also serves `/v1/workflow-groups` (`src/modules/workflow-groups/`), the routes the
CLI deploys through: it keeps each workflow group's upload in the `workflow_groups` table and
runs its Global Controller container through the Docker socket in `DOCKER_SOCKET` (default
`/var/run/docker.sock`; empty, every `/v1` route answers 503). Every route and its shapes are
at `/docs`, and the OpenAPI spec at `/docs/json`; `bun run sdk:generate` writes it to
`openapi.json` and regenerates the [SDK](../sdk/README.md).

With `CANYONOS_API_KEY_HASH` set to the sha256 of the API key (64 lowercase hex characters),
every `/workflows` and `/resources` route needs that key as `Authorization: Bearer <key>`, and
answers 401 without it. Unset or empty, those routes are open; any other value refuses the
start. Every `/v1` route needs the control key in `~/.canyonos/control_key` instead, whose
sha256 is `CANYONOS_CONTROL_KEY_HASH`; without that hash, every `/v1` route is refused.
`GET /auth/status` reports whether a key is needed, and `GET /auth/check` answers 200 to a request
that carries it. See [Authorization](../../docs/guides/AUTHORIZATION.md).

The API stores each workflow group's Redis password encrypted with `REDIS_PASSWORD_ENCRYPTION_KEY`.
Outside development and test it refuses to start without that key, at least 32 characters;
`canyonos serve` and the Helm chart make one and keep it.

To run it locally, see [DEVELOPMENT.md](../../docs/contributing/DEVELOPMENT.md).
