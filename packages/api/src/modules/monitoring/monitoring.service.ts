import { monitoring_store } from './db';
import { SIGNALS } from './monitoring.signals';
import type {
  MonitoringErrorSummaryResponse,
  MonitoringLlmCallsQuery,
  MonitoringLlmCallsResponse,
  MonitoringLogSourcesResponse,
  MonitoringLogsQuery,
  MonitoringLogsResponse,
  MonitoringQuery,
  MonitoringResourceUtilizationResponse,
  MonitoringSeriesResponse,
  MonitoringSignal,
  MonitoringTracesQuery,
  MonitoringTracesResponse,
} from './monitoring.types';

const ORDER: readonly MonitoringSignal[] = ['traffic', 'errors', 'latency', 'saturation'];

export async function get_series(
  project_id: string,
  query: MonitoringQuery
): Promise<MonitoringSeriesResponse> {
  const { time_window } = query;
  const row = await monitoring_store.series(project_id, time_window);

  return {
    project_id,
    time_window,
    bucket_seconds: row.bucket_seconds,
    bucket_start_ats: row.bucket_start_ats,
    series: ORDER.map((signal) => ({
      signal,
      unit: SIGNALS[signal].unit,
      kind: SIGNALS[signal].kind,
      values: row[signal],
    })),
  };
}

export async function get_resource_utilization(
  project_id: string,
  query: MonitoringQuery
): Promise<MonitoringResourceUtilizationResponse> {
  const { time_window } = query;
  const row = await monitoring_store.resource_utilization(project_id, time_window);
  return { project_id, time_window, ...row };
}

export async function get_error_summary(
  project_id: string,
  query: MonitoringQuery
): Promise<MonitoringErrorSummaryResponse> {
  const { time_window } = query;
  const row = await monitoring_store.error_summary(project_id, time_window);
  return { project_id, time_window, ...row };
}

export async function get_logs(
  project_id: string,
  query: MonitoringLogsQuery
): Promise<MonitoringLogsResponse> {
  const { time_window, limit, errors_only, agent, replica } = query;
  return {
    project_id,
    time_window,
    logs: await monitoring_store.logs(project_id, time_window, {
      limit,
      errors_only,
      agent,
      replica,
    }),
  };
}

export async function get_llm_calls(
  project_id: string,
  query: MonitoringLlmCallsQuery
): Promise<MonitoringLlmCallsResponse> {
  const { time_window, limit } = query;
  return {
    project_id,
    time_window,
    calls: await monitoring_store.llm_calls(project_id, time_window, limit),
  };
}

export async function get_traces(
  project_id: string,
  query: MonitoringTracesQuery
): Promise<MonitoringTracesResponse> {
  const { time_window, limit } = query;
  return {
    project_id,
    time_window,
    traces: await monitoring_store.traces(project_id, time_window, limit),
  };
}

export async function get_log_sources(
  project_id: string,
  query: MonitoringQuery
): Promise<MonitoringLogSourcesResponse> {
  const { time_window } = query;
  return {
    project_id,
    time_window,
    sources: await monitoring_store.log_sources(project_id, time_window),
  };
}
