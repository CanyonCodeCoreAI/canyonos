// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SQL } from 'drizzle-orm';

import { unprocessable } from '@core/errors';

const STEP_MINUTES = [1, 5, 15, 30, 60, 180, 360, 720, 1440, 4320] as const;

const TARGET_POINTS = 30;

const DAY_MS = 86_400_000;

const DAY_SECONDS = DAY_MS / 1000;

const EARLIEST_FROM = '2000-01-01T00:00:00Z';

const MAX_SPAN_DAYS = 366;

// Presets resolve `to` to the browser's now, which may run ahead of the server's clock.
const CLOCK_SKEW_MS = DAY_MS;

export const TIME_RANGE_FIELDS = {
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
};

export type TimeRange = { readonly from: string; readonly to: string };

const RANGE_RULES: readonly {
  readonly holds: (from_ms: number, to_ms: number) => boolean;
  readonly message: string;
  readonly path: 'from' | 'to';
}[] = [
  {
    holds: (from_ms, to_ms) => from_ms < to_ms,
    message: 'from must be earlier than to',
    path: 'from',
  },
  {
    holds: (from_ms) => from_ms >= Date.parse(EARLIEST_FROM),
    message: `from must not be earlier than ${EARLIEST_FROM}`,
    path: 'from',
  },
  {
    holds: (_, to_ms) => to_ms <= Date.now() + CLOCK_SKEW_MS,
    message: 'to must not be more than a day in the future',
    path: 'to',
  },
  {
    holds: (from_ms, to_ms) => to_ms - from_ms <= MAX_SPAN_DAYS * DAY_MS,
    message: `The range must not span more than ${MAX_SPAN_DAYS} days`,
    path: 'from',
  },
];

/** A query schema with `from` and `to` plus `shape`, rejecting a range that is backwards or unbounded. */
export const timeRangeQuery = <T extends z.ZodRawShape>(shape: T) =>
  z.object({ ...TIME_RANGE_FIELDS, ...shape }).superRefine((query, ctx) => {
    // The generic shape loses the field types, so the check reads the range through its own type.
    const { from, to } = query as TimeRange;
    const from_ms = Date.parse(from);
    const to_ms = Date.parse(to);
    for (const { holds, message, path } of RANGE_RULES) {
      if (!holds(from_ms, to_ms))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [path] });
    }
  });

/** A query that takes only `from` and `to`. */
export const TimeRangeQuerySchema = timeRangeQuery({});

// ICU also accepts offsets such as `+05:30`, which Postgres reads as POSIX zones with the sign flipped.
const isIanaTimeZone = (time_zone: string): boolean => {
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: time_zone }).resolvedOptions();
    return !/^[+-]/.test(resolved.timeZone);
  } catch {
    return false;
  }
};

const TimeZoneSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(isIanaTimeZone, { message: 'Invalid IANA time zone' });

/** A bucketed series' query: the range, and the zone whose hours and midnights the buckets sit on. */
export const GridQuerySchema = timeRangeQuery({ time_zone: TimeZoneSchema.optional() });

export type GridQuery = TimeRange & { readonly time_zone?: string };

// Postgres raises 22023 for a zone ICU accepts but it lacks; Drizzle wraps that error in `cause`.
function isUnknownTimeZone(error: unknown): boolean {
  for (let cursor = error; cursor != null; cursor = (cursor as { cause?: unknown }).cause) {
    if ((cursor as { code?: unknown }).code === '22023') return true;
  }
  return false;
}

/** Runs a bucketed read, answering 422 rather than 500 for a zone Postgres does not know. */
export async function withTimeZone<T>(query: GridQuery, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (query.time_zone !== undefined && isUnknownTimeZone(error)) {
      throw unprocessable(
        'time_range.invalid_time_zone',
        `Time zone "${query.time_zone}" is not recognized`,
        { cause: error }
      );
    }
    throw error;
  }
}

const rangeSeconds = ({ from, to }: TimeRange): number =>
  (Date.parse(to) - Date.parse(from)) / 1000;

/** The point width for a range: the smallest step giving at most about thirty points. */
export function bucketSeconds(range: TimeRange): number {
  const wanted = rangeSeconds(range) / 60 / TARGET_POINTS;
  return (STEP_MINUTES.find((step) => step >= wanted) ?? STEP_MINUTES.at(-1)!) * 60;
}

const unixNanos = (at: string): SQL => sql`(extract(epoch from ${at}::timestamptz) * 1e9)::bigint`;

/** `column` (an OTel `*_unix_nano` column) inside the half-open range `[from, to)`. */
export const withinRange = (column: string, { from, to }: TimeRange): SQL =>
  sql`${sql.raw(column)} >= ${unixNanos(from)} and ${sql.raw(column)} < ${unixNanos(to)}`;

type Grid = { readonly slots: SQL; readonly count: SQL; readonly position: (at: SQL) => SQL };

// Fixed-width buckets in real time, on the wall-clock hours `from` sees: a DST change later in the
// range shifts the labels after it by the change.
function realTimeGrid(from: SQL, to: SQL, time_zone: string, width_seconds: number): Grid {
  const width = sql`make_interval(secs => ${width_seconds})`;
  const local_from = sql`(${from} at time zone ${time_zone})`;
  const offset_at_from = sql`(${local_from} - (${from} at time zone 'UTC'))`;
  const origin = sql`((date_trunc('day', ${local_from}) - ${offset_at_from}) at time zone 'UTC')`;
  const first = sql`extract(epoch from date_bin(${width}, ${from}, ${origin}))`;
  const count = sql`ceil((extract(epoch from ${to}) - ${first}) / ${width_seconds})::int`;
  return {
    count,
    slots: sql`
      select b, to_timestamp(${first} + (b - 1) * ${width_seconds}) as bucket_start
      from generate_series(1, ${count}) b`,
    position: (at) =>
      sql`(floor((extract(epoch from ${at}) - ${first}) / ${width_seconds})::int + 1)`,
  };
}

// Whole local days, counted from a fixed local date so multi-day buckets keep their place as the
// range moves; a bucket spans 23 or 25 real hours across a DST change.
function localDayGrid(from: SQL, to: SQL, time_zone: string, width_days: number): Grid {
  const day = (at: SQL): SQL =>
    sql`floor((((${at}) at time zone ${time_zone})::date - date '2000-01-01') / ${width_days}::float8)::int`;
  const first = day(from);
  const count = sql`(${day(sql`${to} - interval '1 microsecond'`)} - ${first} + 1)`;
  return {
    count,
    slots: sql`
      select b,
        ((date '2000-01-01' + (${first} + b - 1) * ${width_days})::timestamp at time zone ${time_zone})
          as bucket_start
      from generate_series(1, ${count}) b`,
    position: (at) => sql`(${day(at)} - ${first} + 1)`,
  };
}

/**
 * The bucket grid for a range, on `time_zone`'s wall clock: buckets under a day sit on its hours as
 * of `from`, longer ones on its midnights, so the first and last can be partial. `slots` yields one
 * row per bucket (`b`, 1-based, and `bucket_start`); `index` maps an instant inside the range onto
 * its `b`.
 */
export function timeGrid({ time_zone = 'UTC', ...range }: GridQuery) {
  const bucket_seconds = bucketSeconds(range);
  const from = sql`${range.from}::timestamptz`;
  const to = sql`${range.to}::timestamptz`;
  const grid =
    bucket_seconds < DAY_SECONDS
      ? realTimeGrid(from, to, time_zone, bucket_seconds)
      : localDayGrid(from, to, time_zone, bucket_seconds / DAY_SECONDS);
  return {
    bucket_seconds,
    slots: grid.slots,
    // Callers pass instants rounded to microseconds, which can land on `to` itself.
    index: (at: string): SQL =>
      sql`least(greatest(${grid.position(sql.raw(at))}, 1), ${grid.count})`,
  };
}
