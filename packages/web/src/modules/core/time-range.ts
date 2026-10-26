// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

const MINUTE_MS = 60_000;

export const RANGE_PRESETS = [
  { value: '15m', label: '15 minutes', minutes: 15 },
  { value: '24h', label: '24 hours', minutes: 1440 },
  { value: '7d', label: '7 days', minutes: 7 * 1440 },
  { value: '30d', label: '30 days', minutes: 30 * 1440 },
  { value: '90d', label: '90 days', minutes: 90 * 1440 },
] as const;

export type RangePreset = (typeof RANGE_PRESETS)[number]['value'];

export type TimeRange = { readonly from: string; readonly to: string };

/** A trailing preset, resolved against the clock at each fetch, or a fixed custom range. */
export type RangeSelection = { readonly preset: RangePreset } | TimeRange;

const DEFAULT_PRESET: RangePreset = '7d';

/** The zone every bucket is drawn and labelled in, so a caller asks the API for the same grid. */
export const LOCAL_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export const isRangePreset = (value: string): value is RangePreset =>
  RANGE_PRESETS.some((preset) => preset.value === value);

const RangePresetSchema = z.custom<RangePreset>(
  (value) => typeof value === 'string' && isRangePreset(value)
);

/**
 * The search params of a screen scoped to a metrics window, so a link carries the window it shows.
 * `from` and `to` stay raw strings so a bad link reaches the route's redirect instead of its error
 * screen.
 */
export const metricsWindowSearchSchema = z.object({
  range: RangePresetSchema.default(DEFAULT_PRESET).catch(DEFAULT_PRESET),
  from: z.string().optional(),
  to: z.string().optional(),
});

export type MetricsRangeSearch = z.infer<typeof metricsWindowSearchSchema>;

const InstantSchema = z.string().datetime({ offset: true });

/** The custom range when `from` and `to` are both instants and move forward, otherwise the preset. */
export function rangeSelectionFromSearch(search: MetricsRangeSearch): RangeSelection {
  const from = InstantSchema.safeParse(search.from);
  const to = InstantSchema.safeParse(search.to);
  if (from.success && to.success && Date.parse(from.data) < Date.parse(to.data)) {
    return { from: from.data, to: to.data };
  }
  return { preset: search.range };
}

/** Whether the search names a `from` or `to` that does not make a forward custom range. */
export const hasInvalidCustomRange = (search: MetricsRangeSearch): boolean =>
  (search.from !== undefined || search.to !== undefined) &&
  'preset' in rangeSelectionFromSearch(search);

/** The `from` and `to` to send for a selection; a preset ends now. */
export function resolveRange(selection: RangeSelection, now = Date.now()): TimeRange {
  if (!('preset' in selection)) return selection;
  const { minutes } = RANGE_PRESETS.find((preset) => preset.value === selection.preset)!;
  return {
    from: new Date(now - minutes * MINUTE_MS).toISOString(),
    to: new Date(now).toISOString(),
  };
}

const formatInstant = (at: string, with_year: boolean) =>
  new Date(at).toLocaleString(undefined, {
    year: with_year ? 'numeric' : undefined,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

export function rangeLabel(selection: RangeSelection): string {
  if ('preset' in selection) {
    return RANGE_PRESETS.find((preset) => preset.value === selection.preset)!.label;
  }
  const with_year = new Date(selection.from).getFullYear() !== new Date(selection.to).getFullYear();
  return `${formatInstant(selection.from, with_year)} – ${formatInstant(selection.to, with_year)}`;
}

const DAY_SECONDS = 86_400;
const DATED_TIME_SECONDS = 3 * 3600;

/**
 * A bucket's label. Buckets can be minutes wide, so every time keeps its minutes. `short` keeps one
 * unit: the time when buckets are under three hours, otherwise the date.
 */
export function formatBucketLabel(
  start_at: string,
  bucket_seconds: number,
  { short = false } = {}
): string {
  const at = new Date(start_at);
  const day = at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (bucket_seconds >= DAY_SECONDS) return day;
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (bucket_seconds < DATED_TIME_SECONDS) return time;
  return short ? day : `${day}, ${time}`;
}

/** Ticks to skip so sub-day buckets across several days label each day once; recharts' thinning otherwise. */
export const dailyTickInterval = (bucket_seconds: number): number | undefined =>
  bucket_seconds >= DATED_TIME_SECONDS && bucket_seconds < DAY_SECONDS
    ? DAY_SECONDS / bucket_seconds - 1
    : undefined;
