# API

The dashboard's backend. It takes in the traces a running workflow sends, stores them in
Postgres, and serves them and each project's metrics to the dashboard, behind sign-in.
Built with Bun, Elysia, and Drizzle.

To run it locally, see [DEVELOPMENT.md](../../docs/contributing/DEVELOPMENT.md).
