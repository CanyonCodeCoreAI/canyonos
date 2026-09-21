import type {
  DistributionBucket,
  DistributionMetric,
  DistributionStats,
  MetricsWindow,
} from '@cc-forge/api/metrics';
import type { RequestSort, RequestStatus, SortDirection } from '@cc-forge/api/requests';

import type { CdfPoint } from '@repo/ui/components/charts/cdf-chart';
import type { TimeRangeOption } from '@repo/ui/components/time-range-toggle';

// Relative, like the other sibling imports in this module: the `@/` alias resolves through the
// tsconfig only, and this file has to load under `bun test` as well.
import { formatDurationMs, formatMoneyValue, formatTokens } from './projects.format';

export const METRICS_WINDOW_OPTIONS = [
  { value: '1d', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '1q', label: 'a quarter' },
] as const satisfies readonly TimeRangeOption[];

export const DEFAULT_METRICS_WINDOW: MetricsWindow = '7d';

/** The zone every bucket is drawn and labelled in, so a caller asks the API for the same grid. */
export const LOCAL_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export const METRICS_WINDOW_DAYS: Record<MetricsWindow, number> = {
  '1d': 1,
  '7d': 7,
  '30d': 30,
  '1q': 90,
};

export function isMetricsWindow(value: string): value is MetricsWindow {
  return METRICS_WINDOW_OPTIONS.some((option) => option.value === value);
}

/** The window's name as the toggle prints it, for controls that report the range they inherit. */
export function metricsWindowLabel(time_window: MetricsWindow): string {
  return METRICS_WINDOW_OPTIONS.find((option) => option.value === time_window)!.label;
}

export const DISTRIBUTION_METRIC_OPTIONS = [
  { value: 'cost_per_request', label: 'Cost' },
  { value: 'tokens_per_request', label: 'Tokens' },
  { value: 'latency', label: 'Latency' },
] as const satisfies readonly TimeRangeOption[];

// Names the quantity the histogram is binning, appended to the section heading so the chart says
// what it plots without the reader having to check which toggle is active.
export const DISTRIBUTION_METRIC_TITLE: Record<DistributionMetric, string> = {
  cost_per_request: 'cost per query',
  tokens_per_request: 'tokens per query',
  latency: 'latency per query',
};

// Every figure a distribution renders — bin edges, percentile markers, the mean — is denominated in
// the metric being binned, so the histograms share one formatter per metric.
export const DISTRIBUTION_METRIC_FORMATTER: Record<DistributionMetric, (value: number) => string> =
  {
    cost_per_request: formatMoneyValue,
    tokens_per_request: (value) => formatTokens(value),
    latency: (value) => formatDurationMs(value),
  };

/**
 * A histogram bin the reader has picked, which the queries table beside it lists.
 *
 * Carries the bounds the API filters on plus the label the chart already rendered, so both halves
 * describe the selection with the same words and the same numbers.
 */
export interface DistributionSelection {
  readonly metric: DistributionMetric;
  readonly time_window: MetricsWindow;
  readonly min: number;
  readonly max: number;
  readonly label: string;
  readonly bucket_key: string;
  /**
   * Whether this is one of the dearest bins, which are the ones offered an analysis.
   *
   * Decided by the chart, because only the chart can see where the bin sits among the others, and
   * carried on the selection because the queries listed from it is where the offer appears.
   */
  readonly analyzable: boolean;
}

export function isDistributionMetric(value: string): value is DistributionMetric {
  return DISTRIBUTION_METRIC_OPTIONS.some((option) => option.value === value);
}

export interface RequestDayBounds {
  readonly created_from: string;
  readonly created_to: string;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * The day the reader picked, turned into the window that holds it.
 *
 * A day is a local idea — every timestamp on this screen is rendered in the reader's own zone — so
 * the bounds are local midnight to the next one, sent as UTC instants. The API's range is half-open,
 * so the midnight between two days belongs to exactly one of them.
 */
export function requestDayBounds(day: Date): RequestDayBounds {
  const from = startOfLocalDay(day);
  const to = startOfLocalDay(day);
  to.setDate(to.getDate() + 1);
  return { created_from: from.toISOString(), created_to: to.toISOString() };
}

/**
 * The days the picker offers for a window: every calendar day that window touches.
 *
 * The window is a span of instants, so its start lands mid-day rather than at midnight — that day
 * is partly in range and stays pickable, which is why the span reaches one day further back than
 * the window's own length.
 */
export function selectableDayRange(time_window: MetricsWindow): {
  readonly from: Date;
  readonly to: Date;
} {
  const now = new Date();
  const from = startOfLocalDay(now);
  from.setDate(from.getDate() - METRICS_WINDOW_DAYS[time_window]);
  return { from, to: startOfLocalDay(now) };
}

export interface RequestListFilters {
  readonly time_window?: MetricsWindow;
  readonly status?: RequestStatus;
  readonly selection?: DistributionSelection | null;
  readonly day?: RequestDayBounds | null;
}

/** One page of the queries table: where it starts, how long it is, and how it is ordered. */
export interface RequestsPage {
  readonly limit: number;
  readonly offset: number;
  readonly sort: RequestSort;
  readonly order: SortDirection;
}

// Newest first, matching what the API does when a page names no order at all.
export const DEFAULT_REQUESTS_ORDER: Pick<RequestsPage, 'sort' | 'order'> = {
  sort: 'created_at',
  order: 'desc',
};

/**
 * The order a header click asks for.
 *
 * A new column starts descending, because every orderable column here answers a "which are the
 * worst" question — the most expensive, the slowest, the most retried, the most recent — and
 * ascending would open on the least interesting end. Clicking the active column flips it.
 */
export function nextRequestsOrder(
  current: Pick<RequestsPage, 'sort' | 'order'>,
  column: RequestSort
): Pick<RequestsPage, 'sort' | 'order'> {
  if (current.sort !== column) return { sort: column, order: 'desc' };
  return { sort: column, order: current.order === 'desc' ? 'asc' : 'desc' };
}

// Fewer, wider bins than the API default of 20: the histogram labels every bar, and 12 is what
// fits the chart width without the axis turning into a smear.
export const DISTRIBUTION_BUCKETS = 12;

// `width_bucket` bins are lower-inclusive / upper-exclusive with the last bin closed, the rule
// every histogram the API builds follows.
export function distributionBucketIndex(
  value: number | null,
  buckets: readonly DistributionBucket[]
): number | undefined {
  if (value === null) return undefined;
  const last = buckets.length - 1;
  const index = buckets.findIndex(
    (bucket, position) =>
      value >= bucket.lower && (position === last ? value <= bucket.upper : value < bucket.upper)
  );
  return index < 0 ? undefined : index;
}

/**
 * The cumulative curve a distribution's buckets already contain: after each bucket, `share`% of
 * the queries (`count` of them) sat at or under its upper edge. Opens at the first bucket's floor
 * so the curve rises from the axis rather than starting mid-air.
 */
export function distributionCdfPoints(stats: DistributionStats): CdfPoint[] {
  const first = stats.buckets[0];
  if (!first || stats.request_count === 0) return [];
  const points: CdfPoint[] = [{ share: 0, count: 0, value: first.lower }];
  let counted = 0;
  for (const bucket of stats.buckets) {
    counted += bucket.count;
    points.push({
      share: (counted / stats.request_count) * 100,
      count: counted,
      value: bucket.upper,
    });
  }
  return points;
}

// One source for the model-vs-harness split: the flow board, the timeseries bands, the block rows
// and every legend read the same key, colour and labels, so a node, a band and a row for the same
// side always match. `long` is the spelled-out form the split legend uses when it has the room.
// Model spend is the violet of the palette and harness/compute the blue, matching the design and
// the runtime's own charts — swapping them reads as a different metric to anyone who knows both.
export const COST_SPLIT = {
  harness_cost: { label: 'Harness', long: 'Harness & compute', color: 'var(--chart-2)' },
  llm_cost: { label: 'Model', long: 'Model tokens', color: 'var(--chart-5)' },
} as const;

export type CostSplitSide = keyof typeof COST_SPLIT;

/**
 * Hue order for the per-agent share donut, and the number of agents it names.
 *
 * Not `--chart-1..5` in numeric order: chart-3 (gold) beside chart-4 (orange) separates by ΔE 12.7
 * for normal vision, under the 15 a reader needs to tell two slices apart, and chart-5 beside
 * chart-6 falls to 7.4 under deuteranopia. This order keeps the worst adjacent pair at 12.6 (CVD)
 * and 20.7 (normal), which is why it looks arbitrary. Re-check with the palette validator before
 * reordering it.
 *
 * Five hues, not six: the tail folds into one neutral slice instead of taking a sixth colour, and a
 * sixth hue would be the pair that fails. Every slice is labelled in the legend beside it, which is
 * also the relief the two low-contrast tokens need.
 */
export const AGENT_SHARE_HUES = [
  'var(--chart-1)',
  'var(--chart-5)',
  'var(--chart-3)',
  'var(--chart-2)',
  'var(--chart-4)',
] as const;

/** The folded tail is not one of the categories, so it is ink rather than a hue. */
export const AGENT_SHARE_OTHER_COLOR = 'var(--muted-foreground)';
