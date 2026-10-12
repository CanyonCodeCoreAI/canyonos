---
name: python-systems
description: Design, change, or review Python services, workers, CLIs, and distributed runtime behavior. Use for process lifecycles, shared state, concurrency, recovery, configuration, and operational boundaries.
---

# Python Systems

Make the system correct when work is concurrent, retried, interrupted, or run in
more than one process. Prefer ordinary synchronous Python and the platform's
existing primitives over a new framework or local coordination scheme.

## Choose the owner before writing code

Ask in this order:

1. Which process or boundary owns the decision, lifecycle, and recovery?
2. Can the database, queue, lock, supervisor, or existing service make the
   invariant durable?
3. Is a request-path change necessary, or can asynchronous coordination own it?

Keep request paths small. Put bookkeeping, reconciliation, aggregation, and
cleanup in the durable owner rather than every request handler. Do not introduce
an in-process cache, thread, identifier scheme, or retry loop when an existing
owner can be extended.

## Design for interruption and retries

- Treat process memory as one replica's view. Put shared state and transitions in
  a durable system with an atomic operation, uniqueness constraint, or lock when
  they can race.
- A multi-system operation can partially succeed. Define ordering, idempotency,
  and a way to recover or converge before claiming it is atomic.
- Bound network calls and retries. Retry only transient operations that are safe
  to repeat; preserve the original failure when recovery is not possible.
- Give background work explicit ownership, shutdown behavior, failure logging,
  and cleanup. A loop must not silently die after one failed iteration.

## Keep contracts local and explicit

- Validate input at the boundary; keep domain rules near the domain contract.
  Reuse authoritative schemas, configuration, logging, and process-management
  utilities rather than duplicating them.
- Catch errors only to recover or translate a boundary failure. Do not turn
  failures into success-shaped defaults or log secrets and full request bodies.
- Make CLI output and public errors actionable: identify the failed operation and
  the safe next step without exposing implementation internals.

## Verify the actual boundary

Exercise the changed command, worker, service, or integration with failure and
restart conditions relevant to the change. Report the checks that ran and the
ones that require unavailable infrastructure.

For CanyonOS Python changes, read [the repository reference](references/canyonos.md)
before editing: it contains maintained module owners, package constraints, and
area-specific commands.
