# Monitoring query layer — architecture

## The flow

```
HTTP GET /projects/:id/monitoring/series?time_window=1d
  │
  ├─ monitoring.routes.ts
  │    resolveAuth → resolveProjectAccess → validate params and query (zod)
  │
  ├─ monitoring.service.ts
  │    get_series(project_id, query)
  │    attaches project_id + time_window, maps rows onto the contract
  │
  ├─ db/index.ts
  │    monitoring_store — the one place a database is named
  │
  ├─ db/postgres.ts
  │    postgres_store.series() — builds the grid, runs one statement
  │
  └─ response validated against MonitoringSeriesResponseSchema on the way out
```

Four layers, each with one job:

- **Routes** own HTTP: auth, project access, request validation, response validation. No logic.
- **Service** owns the contract: it decides what a response object contains. It never sees SQL.
- **Store** owns the database: bucketing, scoping, dialect. It never sees HTTP.
- **Signals** own vocabulary: what `latency` means in units and kind, with no query attached.

The direction is strict. `monitoring.service.ts` imports `./db`, never `./db/postgres`, so nothing
above the store layer names a database.

## The contract

`monitoring.types.ts` is the whole surface. The web app imports it through the
`@canyonos/api/monitoring` SDK subpath and gets the same types the server validates against.

Two shapes recur:

**The hoisted grid.** `bucket_start_ats` appears once per response and every series aligns to it by
index. Index 3 of any array is the same instant as index 3 of every other — structurally, not
because the service remembered. Per-point `{start_at, value}` objects would make that a promise
rather than a fact and repeat the timestamps once per series.

**Null means unmeasured.** A bucket with no reading is `null`, never `0`. A gauge that nobody
sampled is unknown; drawing it as zero invents an outage. Counts are the exception — traffic and
errors coalesce to `0`, because a bucket in which nothing failed genuinely saw zero failures.

`kind` on a signal separates a _flow_ (counted over a bucket, totals across them) from a _stock_ (a
level sampled at an instant, where summing or stacking means nothing). Without it, nothing stops a
client stacking percentages into a plausible-looking wrong number.

## Invariants

These are the things a change can quietly break.

**One grid per response.** Every array in one response must come off a grid resolved exactly once.
Two statements each calling `now()` will disagree the moment a run crosses an hour boundary, and the
arrays stop lining up while still being the same length — which is worse than an error. Postgres
enforces this by computing everything in a single statement off one `grid` CTE.

**Bucket width is never a client parameter.** The client names a window; the server picks the
bucket count. Otherwise a 30-day request at one-minute buckets is 43,000 buckets and a full scan, on
a five-second refresh loop.

**Project scoping is an argument, not a filter.** `projectSpans()` builds the tenant predicate into
the FROM clause, so there is no code path that omits it. Note the spelling differs by signal: spans
carry `canyon.project.id` (normalized at ingest), metrics and logs carry `canyonos.project.id` from
the producer. Reading the wrong one returns zero rows and no error.

**Aggregates may be interpolated; values may not.** Signal names and aggregates come from closed
sets of literals in source, which is what makes `sql.raw` safe for them. Anything caller-supplied is
a bound parameter, always.

**Spans over counters.** Traffic and errors read `otel_spans` even though `canyonos.agent.requests`
and `canyonos.agent.failures` exist as counters, because an OTel cumulative counter resets to zero
on process restart and differencing that correctly is work no signal needs yet. Whoever adds the
first `sum_cumulative` signal writes the reset handling first.

## Vocabulary reuse

The module is a new _query shape_, not a new _span vocabulary_. `spanFailed`, `spanStart`,
`spanDurationMs`, `isModelSpan`, `spanModel`, `projectSpans` and the token and cost accessors all
come from `modules/metrics/metrics.sql.ts`, with their JSONB type guards already worked out. A
second definition of "what counts as a failed span" that drifts from the first is worse than the
duplication it saves — and it is why the LLM screen and the cost screen can never disagree on what a
model call is.

## The store seam

`db/store.ts` declares `MonitoringStore`, typed in the contract's vocabulary with no SQL. A
future backend can implement that interface without changing the routes or service.

## Known gaps

- **No tests**, at any level, for any endpoint. The largest gap.
- **No cache.** The dashboard refreshes on a loop and every request reaches the database.
- **No rollups or retention.** Machine metrics are roughly 350k rows per day per host.
- **No index** on `otel_metrics` covering `resource_attributes ->> 'canyonos.project.id'`, so every
  saturation and resource query scans and filters after.
- **No validation between store and contract.** Each store method ends in `as unknown as`; the only
  real check is the route validating the response at runtime.
