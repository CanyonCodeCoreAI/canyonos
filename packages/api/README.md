# API

The dashboard's backend. It takes in the traces a running workflow sends, stores them in
Postgres, and serves them and each deployment's metrics to the dashboard. Built with Bun,
Elysia, and Drizzle.

Every `/projects` and `/resources` route needs an API token from
`canyonos token create`, sent as `Authorization: Bearer <token>`: a `read` token on a
`GET`, a `write` token on any other method. A write token also reads what it can change:
project detail, scaling, governance and prompts. The API verifies tokens with the public
keys in `AUTH_TRUSTED_KEYS_DIR`, read once when it starts. `AUTH_DISABLED=true` turns
verification off, and `GET /auth/status` reports whether it is. See
[Tokens and keys](../../docs/guides/AUTHORIZATION.md).

The API stores each deployment's Redis password encrypted with `REDIS_PASSWORD_ENCRYPTION_KEY`.
Outside development and test it refuses to start without that key, at least 32 characters;
`canyonos serve` and the Helm chart make one and keep it.

To run it locally, see [DEVELOPMENT.md](../../docs/contributing/DEVELOPMENT.md).
