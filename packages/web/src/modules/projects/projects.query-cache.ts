// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { InvalidateQueryFilters, QueryClient } from '@tanstack/react-query';

import { resolveRange } from '../core/time-range';
import type { RangeSelection, TimeRange } from '../core/time-range';

export const projectQueryKeys = {
  all: ['projects'] as const,
  detail: (project_id: string) => ['projects', project_id] as const,
  prompts: (project_id: string) => ['projects', project_id, 'prompts'] as const,
  prompt: (project_id: string, name: string) => ['projects', project_id, 'prompts', name] as const,
  scaling: (project_id: string) => ['projects', project_id, 'scaling'] as const,
  scalingAgents: (project_id: string) => ['projects', project_id, 'scaling', 'agents'] as const,
  governance: (project_id: string) => ['projects', project_id, 'governance'] as const,
};

export async function retryProjectDetailLoader(
  query_client: QueryClient,
  project_id: string,
  invalidate_route: () => Promise<void>,
  reset: () => void
): Promise<void> {
  query_client.removeQueries({
    queryKey: projectQueryKeys.detail(project_id),
    exact: true,
  });
  await invalidate_route();
  reset();
}

export const DASHBOARD_POLL_INTERVAL_MS = 5_000;

/**
 * The background re-read a dashboard section carries, as `refetchInterval`.
 *
 * A section that already has data keeps it while the tick runs, so the numbers change with no
 * skeleton and no disabled control — provided nothing renders off `isFetching`.
 *
 * A section whose last read failed drops out of the interval. None of these queries retry, so a
 * broken endpoint would otherwise be asked again every few seconds for as long as the tab is open.
 *
 * The parameter is the part of a `Query` this reads rather than `Query` itself, and its `error` is
 * the real type: either shortcut makes `useQuery` infer the section's data and error as `unknown`.
 */
export const dashboardPollInterval = (section: { state: { error: Error | null } }) =>
  section.state.error ? false : DASHBOARD_POLL_INTERVAL_MS;

/** The project's queries whose object holds a range: what a re-read of the shown preset refreshes. */
export const rangedQueries = (project_id: string): InvalidateQueryFilters => ({
  queryKey: ['projects', project_id],
  predicate: (query) =>
    query.queryKey.some((part) => typeof part === 'object' && part !== null && 'range' in part),
});

/**
 * The `from` and `to` a range asks for. A preset ends on the latest poll tick rather than the
 * millisecond each query runs, so the sections read on one tick all describe the same instants.
 */
export const rangeParams = (range: RangeSelection, now = Date.now()): TimeRange =>
  resolveRange(range, Math.floor(now / DASHBOARD_POLL_INTERVAL_MS) * DASHBOARD_POLL_INTERVAL_MS);

/**
 * A resource's query object as the `$query` it sends: the range resolved, every other field as is.
 * An unset field is left out, since the client would otherwise send it as the string "undefined".
 */
export function toParams<Query extends { readonly range: RangeSelection }>({
  range,
  ...fields
}: Query): Omit<Query, 'range'> & TimeRange {
  const set = Object.entries(fields).filter(([, value]) => value !== undefined);
  return { ...(Object.fromEntries(set) as Omit<Query, 'range'>), ...rangeParams(range) };
}
