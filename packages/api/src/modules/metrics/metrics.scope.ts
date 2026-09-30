import type { MetricsWindow } from './metrics.types';

/**
 * The trailing interval each window names, as the SQL literal every windowed surface scopes with.
 * Static literals only — nothing user-supplied is ever interpolated into a query.
 */
export const WINDOW_INTERVALS: Record<MetricsWindow, string> = {
  '1d': '1 day',
  '7d': '7 days',
  '30d': '30 days',
  '1q': '90 days',
};

// Resolved by Postgres so every window compared in one response measures against the same `now()`.
export const window_floor_nanos = (key: MetricsWindow): string =>
  `(extract(epoch from now() - interval '${WINDOW_INTERVALS[key]}') * 1e9)::bigint`;

/** Reads every span the project owns, for the parent walk that must see blocks older than the window. */
export const NO_FLOOR = '0::bigint';
