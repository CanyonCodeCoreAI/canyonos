# API

The dashboard's backend. It takes in the traces a running workflow sends, stores them in
Postgres, and serves them and each workflow's metrics to the dashboard. Built with Bun,
Elysia, and Drizzle.

With `CANYONOS_API_KEY_HASH` set to the sha256 of the API key (64 lowercase hex characters),
every `/workflows` and `/resources` route needs that key as `Authorization: Bearer <key>`, and
answers 401 without it. Unset or empty, every route is open; any other value refuses the start.
`GET /auth/status` reports whether a key is needed, and `GET /auth/check` answers 200 to a request
that carries it. See [Authorization](../../docs/guides/AUTHORIZATION.md).

The API stores each workflow group's Redis password encrypted with `REDIS_PASSWORD_ENCRYPTION_KEY`.
Outside development and test it refuses to start without that key, at least 32 characters;
`canyonos serve` and the Helm chart make one and keep it.

To run it locally, see [DEVELOPMENT.md](../../docs/contributing/DEVELOPMENT.md).
