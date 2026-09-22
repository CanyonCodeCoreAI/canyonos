import { notFound, unprocessable } from '@core/errors';

import { metrics_repo } from './metrics.repo';
import type {
  AgentDetailsQuery,
  DistributionQuery,
  MetricsAgentDetails,
  MetricsBlocks,
  MetricsDistribution,
  MetricsFlow,
  MetricsKpis,
  MetricsTimeseries,
  MetricsWindow,
  TimeseriesQuery,
  TimeWindowQuery,
} from './metrics.types';

// A day reads naturally as 24 hourly points; the longer windows get 30, which is a point per day
// at 30d and a point per three days over a quarter.
const default_buckets = (time_window: MetricsWindow): number => (time_window === '1d' ? 24 : 30);

export async function get_kpis(project_id: string): Promise<MetricsKpis> {
  return metrics_repo.kpis_by_project(project_id);
}

export async function get_distribution(
  project_id: string,
  query: DistributionQuery
): Promise<MetricsDistribution> {
  return metrics_repo.distribution_by_project(
    project_id,
    query.metric,
    query.time_window,
    query.buckets
  );
}

// The refine on `time_zone` accepts every zone ICU knows, but Postgres reads the same string against
// its own catalog and raises SQLSTATE 22023 for the zones it lacks (a bare offset like `-0800`, say).
// `time_zone` is the only invalid-parameter value this query can carry — `buckets` is a bounded int
// and the window units are static literals — so the code alone names a zone Postgres cannot resolve.
// Drizzle wraps the driver failure in a DrizzleQueryError, so the PostgresError with the code sits on
// `cause`; walk the chain rather than read the top level.
function is_unknown_time_zone(error: unknown): boolean {
  for (let cursor = error; cursor != null; cursor = (cursor as { cause?: unknown }).cause) {
    if ((cursor as { code?: unknown }).code === '22023') return true;
  }
  return false;
}

export async function get_timeseries(
  project_id: string,
  query: TimeseriesQuery
): Promise<MetricsTimeseries> {
  const time_zone = query.time_zone ?? 'UTC';
  try {
    return await metrics_repo.timeseries_by_project(
      project_id,
      query.time_window,
      query.buckets ?? default_buckets(query.time_window),
      time_zone
    );
  } catch (error) {
    if (is_unknown_time_zone(error)) {
      throw unprocessable(
        'metrics.invalid_time_zone',
        `Time zone "${time_zone}" is not recognized`
      );
    }
    throw error;
  }
}

export async function get_blocks(
  project_id: string,
  query: TimeWindowQuery
): Promise<MetricsBlocks> {
  return metrics_repo.blocks_by_project(project_id, query.time_window);
}

export async function get_agent_details(
  project_id: string,
  agent_id: string,
  query: AgentDetailsQuery
): Promise<MetricsAgentDetails> {
  const time_zone = query.time_zone ?? 'UTC';
  let details: MetricsAgentDetails | null;
  try {
    details = await metrics_repo.agent_details_by_project(project_id, agent_id, time_zone);
  } catch (error) {
    if (is_unknown_time_zone(error)) {
      throw unprocessable(
        'metrics.invalid_time_zone',
        `Time zone "${time_zone}" is not recognized`
      );
    }
    throw error;
  }
  if (!details) {
    throw notFound(
      'metrics.agent_not_found',
      `Agent "${agent_id}" has no telemetry data for this project in the last 30 days`
    );
  }
  return details;
}

export async function get_flow(project_id: string, query: TimeWindowQuery): Promise<MetricsFlow> {
  return metrics_repo.flow_by_project(project_id, query.time_window);
}
