# API

The dashboard's backend. It takes in the traces a running workflow sends, stores them in
Postgres, and serves them and each project's metrics to the dashboard. Built with Bun,
Elysia, and Drizzle.

`AUTH_MODE` decides who can read them. With `none`, the default, every route answers
without sign-in. With `password`, the API needs `JWT_SECRET`, `/auth/register` creates the
first account, and every project route asks for a bearer token. `GET /auth/status` reports
the mode.

The API stores each project's Redis password encrypted with `REDIS_PASSWORD_ENCRYPTION_KEY`.
Outside development and test it refuses to start without that key, at least 32 characters;
`canyonos serve` and the Helm chart make one and keep it.

To run it locally, see [DEVELOPMENT.md](../../docs/contributing/DEVELOPMENT.md).
