const MISSING = '—';

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
// Per-query and per-block costs live well below a cent, where two decimals would render every
// figure as $0.00.
const USD_SUB_CENT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 4,
  maximumFractionDigits: 6,
});
const USD_COMPACT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});
// One query costs cents to a few dollars, a band where the two decimals the rest of the screen
// uses round neighbouring queries onto the same figure.
const USD_QUERY = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});
// A block inside one query bills a fraction of a cent, so its column is denominated in cents
// instead of asking the reader to count leading zeros down every row of a trace.
const CENTS = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 3,
});
const COUNT = new Intl.NumberFormat('en-US');
const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const PERCENT = new Intl.NumberFormat('en-US', {
  style: 'percent',
  maximumFractionDigits: 1,
});
// The year is carried even for a day inside the current one: the quarter window reaches across a
// year boundary, where "Dec 31" alone names two different days.
const DAY = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});
const DATE_TIME = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/**
 * Costs arrive as fixed 6-decimal strings because the API sums them in exact `numeric`. Parsing is
 * for rendering and chart geometry only — every total, split and average on this screen is read
 * straight off the payload rather than re-derived from these floats.
 */
export function parseMoney(amount: string): number {
  const value = Number(amount);
  return Number.isFinite(value) ? value : 0;
}

export function formatMoney(amount: string | null): string {
  if (amount === null) return MISSING;
  const value = Number(amount);
  if (!Number.isFinite(value)) return MISSING;
  if (value !== 0 && Math.abs(value) < 0.01) return USD_SUB_CENT.format(value);
  return USD.format(value);
}

export function formatMoneyValue(value: number): string {
  if (value !== 0 && Math.abs(value) < 0.01) return USD_SUB_CENT.format(value);
  return Math.abs(value) >= 1000 ? USD_COMPACT.format(value) : USD.format(value);
}

/** A single query's own total. Below a cent `formatMoney` already widens the fraction far enough. */
export function formatQueryCost(amount: string): string {
  const value = parseMoney(amount);
  return Math.abs(value) >= 0.01 ? USD_QUERY.format(value) : formatMoney(amount);
}

/** One block's slice of a query, in the cents its column is labelled with. */
export function formatBlockCostCents(amount: string): string {
  return `${CENTS.format(parseMoney(amount) * 100)}¢`;
}

/**
 * How many times over one figure is another: `0.4×`, `1.4×`, `170×`. Whole numbers only from 10×
 * up, since rounding below that reads every ratio from 0.5 to 1.4 as the same `1×`.
 */
export function formatMultiple(value: number): string {
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)}×`;
}

export function formatCount(value: number): string {
  return COUNT.format(value);
}

/**
 * A count that has to fit somewhere narrow: exact up to five figures, then compact.
 *
 * `9,999`, `10K`, `1.2M`. The threshold is where the separators start costing more room than the
 * digits are worth reading.
 */
export function formatCompactCount(value: number): string {
  return Math.abs(value) >= 10_000 ? COMPACT.format(value) : COUNT.format(Math.round(value));
}

export function formatTokens(value: number | null): string {
  if (value === null) return MISSING;
  return formatCompactCount(value);
}

export function formatDurationMs(milliseconds: number | null): string {
  if (milliseconds === null) return MISSING;
  if (milliseconds >= 60_000) return `${(milliseconds / 60_000).toFixed(1)} min`;
  if (milliseconds >= 1000) return `${(milliseconds / 1000).toFixed(1)} s`;
  return `${Math.round(milliseconds)} ms`;
}

/** Rates come back as 0–1 fractions, null when the block never ran in the window. */
export function formatRate(fraction: number | null): string {
  return fraction === null ? MISSING : PERCENT.format(fraction);
}

export function formatShare(numerator: number, denominator: number): string {
  return denominator > 0 ? PERCENT.format(numerator / denominator) : MISSING;
}

export function formatDay(day: Date): string {
  return DAY.format(day);
}

/** A session's creation timestamp, shown in the reader's local timezone. */
export function formatDateTime(timestamp: string | null): string {
  if (timestamp === null) return MISSING;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? MISSING : DATE_TIME.format(date);
}

export function formatPayload(payload: unknown): string {
  if (payload === null) return MISSING;
  if (typeof payload === 'string') return payload.trim() === '' ? MISSING : payload;
  return JSON.stringify(payload, null, 2) ?? MISSING;
}

/**
 * A query's input is the runtime's whole request envelope (`{ prompt, … }` or `{ query, … }`
 * depending on the harness), of which the textual prompt is the only part a reader recognises the
 * query by. Shown alone, and as prose rather than a quoted JSON string. An envelope carrying
 * neither has nothing to single out, so it falls back to the payload as stored.
 */
export function formatQueryInput(input: unknown): string {
  if (input === null || typeof input !== 'object') return formatPayload(input);
  const { prompt, query } = input as { readonly prompt?: unknown; readonly query?: unknown };
  const text = typeof prompt === 'string' ? prompt : typeof query === 'string' ? query : null;
  if (text === null) return formatPayload(input);
  return text.trim() === '' ? MISSING : text;
}

// Session ids are opaque uuids: the head tells two of them apart at a glance, and the tail is what
// makes the pair unique enough to match against a log line.
const ID_HEAD_LENGTH = 8;
const ID_TAIL_LENGTH = 4;

/** `6215f346…0001` — enough of a session id to recognise, short enough for a table cell. */
export function shortRequestId(session_id: string): string {
  if (session_id.length <= ID_HEAD_LENGTH + ID_TAIL_LENGTH + 1) return session_id;
  return `${session_id.slice(0, ID_HEAD_LENGTH)}…${session_id.slice(-ID_TAIL_LENGTH)}`;
}

/** `1–8 of 1,842`, or `0 of 0` when there is nothing to page through. */
export function formatPageRange(offset: number, shown: number, total: number): string {
  if (total === 0 || shown === 0) return `0 of ${formatCount(total)}`;
  return `${formatCount(offset + 1)}–${formatCount(offset + shown)} of ${formatCount(total)}`;
}
