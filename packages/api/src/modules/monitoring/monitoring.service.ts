import { assert_project_running, with_redis } from '../canyonos/canyonos.redis';
import { monitoring_repo } from './monitoring.repo';
import { SIGNALS } from './monitoring.signals';
import { MonitoringSignalSchema } from './monitoring.types';
import type { EndpointAddress } from './monitoring.repo';
import type {
  MonitoringEndpoint,
  MonitoringEndpointResponse,
  MonitoringErrorSummaryResponse,
  MonitoringListQuery,
  MonitoringLlmCallsResponse,
  MonitoringLogSourcesResponse,
  MonitoringLogsQuery,
  MonitoringLogsResponse,
  MonitoringQuery,
  MonitoringReplicasResponse,
  MonitoringResourceEntry,
  MonitoringResourceUtilizationResponse,
  MonitoringSeriesResponse,
  MonitoringTracesResponse,
} from './monitoring.types';

export async function get_series(
  project_id: string,
  query: MonitoringQuery
): Promise<MonitoringSeriesResponse> {
  const { bucket_seconds, bucket_start_ats, ...values } = await monitoring_repo.series(
    project_id,
    query
  );
  return {
    project_id,
    time_window: query.time_window,
    bucket_seconds,
    bucket_start_ats,
    series: MonitoringSignalSchema.options.map((signal) => ({
      signal,
      ...SIGNALS[signal],
      ...values[signal],
    })),
  };
}

const leading_empty_buckets = (entries: MonitoringResourceEntry[]): number => {
  const firsts = entries
    .flatMap((entry) => entry.series.map((series) => series.values.findIndex((v) => v !== null)))
    .filter((index) => index >= 0);
  return firsts.length === 0 ? 0 : Math.min(...firsts);
};

const drop_buckets = (entries: MonitoringResourceEntry[], count: number) =>
  entries.map((entry) => ({
    ...entry,
    series: entry.series.map((series) => ({ ...series, values: series.values.slice(count) })),
  }));

// The window opens on the first bucket anything was measured in, so a chart does not start on a
// run of empty buckets. A window with no readings at all keeps its full grid.
export async function get_resource_utilization(
  project_id: string,
  query: MonitoringQuery
): Promise<MonitoringResourceUtilizationResponse> {
  const row = await monitoring_repo.resource_utilization(project_id, query);
  const leading = leading_empty_buckets([...row.machines, ...row.agents]);
  return {
    project_id,
    time_window: query.time_window,
    bucket_seconds: row.bucket_seconds,
    bucket_start_ats: row.bucket_start_ats.slice(leading),
    machines: drop_buckets(row.machines, leading),
    agents: drop_buckets(row.agents, leading),
  };
}

export async function get_error_summary(
  project_id: string,
  query: MonitoringQuery
): Promise<MonitoringErrorSummaryResponse> {
  const row = await monitoring_repo.error_summary(project_id, query);
  return { project_id, time_window: query.time_window, ...row };
}

export async function get_logs(
  project_id: string,
  query: MonitoringLogsQuery
): Promise<MonitoringLogsResponse> {
  return {
    project_id,
    time_window: query.time_window,
    logs: await monitoring_repo.logs(project_id, query),
  };
}

export async function get_llm_calls(
  project_id: string,
  query: MonitoringListQuery
): Promise<MonitoringLlmCallsResponse> {
  return {
    project_id,
    time_window: query.time_window,
    calls: await monitoring_repo.llm_calls(project_id, query),
  };
}

export async function get_traces(
  project_id: string,
  query: MonitoringListQuery
): Promise<MonitoringTracesResponse> {
  return {
    project_id,
    time_window: query.time_window,
    traces: await monitoring_repo.traces(project_id, query),
  };
}

export async function get_log_sources(
  project_id: string,
  query: MonitoringQuery
): Promise<MonitoringLogSourcesResponse> {
  return {
    project_id,
    time_window: query.time_window,
    sources: await monitoring_repo.log_sources(project_id, query),
  };
}

export async function get_replicas(project_id: string): Promise<MonitoringReplicasResponse> {
  return { project_id, replicas: await monitoring_repo.replicas(project_id) };
}

const EXAMPLE_ARGUMENT_VALUE = 'your query';

function describe_endpoint(address: EndpointAddress): MonitoringEndpoint {
  return {
    url: address.url,
    status_url: `http://${address.public_host}:${address.api_port}/status`,
    agent: address.agent,
    method: address.method,
    arguments: address.arguments,
    example_body: Object.fromEntries(
      address.arguments.map((name) => [name, EXAMPLE_ARGUMENT_VALUE])
    ),
  };
}

// The controller records its endpoint's address only while it runs one.
export async function get_endpoint(project_id: string): Promise<MonitoringEndpointResponse> {
  return with_redis(project_id, async (redis) => {
    await assert_project_running(redis, project_id);
    const address = await monitoring_repo.endpoint(redis);
    return { project_id, endpoint: address ? describe_endpoint(address) : null };
  });
}
