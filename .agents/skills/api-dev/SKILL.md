---
name: api-dev
description: Build, simplify, or review Bun/Elysia APIs using Zod contracts and Drizzle/Postgres persistence. Use for endpoints, domain services, authorization, transactions, and SDK contracts.
---

# API Development

Deliver clear resource operations with one source of truth for contracts and
business rules. Let the framework and database enforce what they already support.

## Choose the owner before writing code

Ask in this order:

1. Can Elysia, Zod, Drizzle, or Postgres express this behavior directly? Prefer
   their validation, composition, query, constraint, and transaction capabilities.
2. Which boundary owns the behavior? Keep HTTP handling in routes, business rules
   in services, persistence queries in repositories, and contracts in domain types.
3. Does this abstraction add behavior or useful reuse? Prefer plain functions and
   explicit dependencies over generic base repositories and pass-through wrappers.

Read the installed versions and relevant official APIs before adding custom
parsing, middleware, SQL orchestration, or compatibility workarounds.

## Contracts are canonical

- Define request and response schemas with Zod. Derive TypeScript types with
  `z.infer`; derive variants with schema composition, `Pick`, or `Omit` rather
  than redeclaring fields.
- Own domain parsing, identifier interpretation, and shared calculations beside
  the domain contract. Export them for consumers instead of making the UI
  reinterpret the same values.
- Infer database row and insert types from Drizzle. Define public responses
  deliberately; persistence rows are not automatically the API contract.
- Export consumer-facing schemas, types, and pure domain helpers through the SDK.
  Keep server dependencies out of these exports. Verify the public export and
  build configuration together so consumers can import the contract.

## Let Elysia own the HTTP boundary

- Declare params, query, body, and response schemas in route options. Consume
  Elysia's validated values; do not parse the same request again in the handler.
- Keep routes thin: resolve context, call the service, and set the appropriate
  HTTP status. Use the framework's plugins, guards, and resolvers for shared
  behavior, with deliberate scope and registration order.
- Reuse authentication and resource-access resolution. Authenticate before
  checking access; a resource ID supplied by the caller never establishes access.
  Apply the application's actual access model rather than inventing another one.
- Express distinct operations explicitly: list resources, read details, create a
  version, change the active version. Avoid overloaded endpoints and flag-driven
  actions that hide different contracts or side effects.
- Keep list responses focused on summaries and detail responses on the requested
  resource. Do not fetch every detail just to render a listing.

## Services own rules; repositories own queries

- Name operations after domain behavior. Services coordinate rules and side
  effects; repositories accept the connection or transaction they should use.
- Respect established lifecycle ownership. A feature operation must not silently
  create or repair prerequisite resources that another operation owns.
- Keep queries explicit and parameterized. Use database filtering, joins,
  aggregates, ordering, and bounded pagination instead of loading everything to
  process in JavaScript. Avoid per-row query loops when a set operation fits.
- Enforce durable invariants with database constraints. Choose a transaction for
  writes that must succeed together; use conditional updates, locks, or uniqueness
  guarantees for transitions that can race. Check the result of the write.
- Treat database, Redis, and external-service writes as separate failure domains.
  A database transaction cannot roll back a remote side effect. Define ordering,
  idempotency, and recovery when partial success is possible; do not promise
  atomicity that the operation cannot provide.

## Errors and operations

- Use the shared application error helpers and central HTTP error handling.
  Keep machine-readable codes stable. Catch only to recover or translate a
  boundary failure, preserve the cause, and never return success-shaped defaults.
- Use shared configuration, logging, and telemetry capabilities. Keep environment
  reads in configuration and preserve request/trace context across service work.
  Record meaningful operation outcomes without exposing secrets or request bodies.
- Bound external calls with timeouts. Retry only transient failures when repeating
  the operation is safe; do not create detached work without lifecycle ownership.

## Verify the contract and behavior

Exercise changed endpoints through the real application boundary, preferably with
Eden Treaty and the public SDK. Check relevant authentication, access, validation,
not-found, conflict, and success behavior. For persistence changes, verify actual
constraints, rollback, or concurrency rather than proving only mocked calls.

Check schema migrations and consumer imports when contracts change. Run repository
checks and the affected API tests; report actual results and remaining gaps.

It's simpler to always just spin the API up, and call the endpoint, check the logs and response to verify it's behavior.

Consult the relevant official documentation as needed:
[Elysia validation](https://elysiajs.com/essential/validation),
[Elysia lifecycle](https://elysiajs.com/essential/life-cycle), and
[Drizzle transactions](https://orm.drizzle.team/docs/transactions).
