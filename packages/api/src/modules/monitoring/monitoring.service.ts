// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { withTimeZone } from '@core/time-range';
import type { GridQuery, TimeRange } from '@core/time-range';

import { assert_workflow_running, with_redis } from '../registry/registry.redis';
import { monitoring_repo } from './monitoring.repo';
import { SIGNALS } from './monitoring.signals';
import { MonitoringSignalSchema } from './monitoring.types';
import type { EndpointAddress } from '../registry/registry.contract';
import type {
  MonitoringEndpoint,
  MonitoringEndpointResponse,
  MonitoringErrorSummaryResponse,
  MonitoringListQuery,
  MonitoringLlmCallsResponse,
  MonitoringLogSource,
  MonitoringLogSourcesResponse,
  MonitoringLogsQuery,
  MonitoringLogsResponse,
  MonitoringReplicasResponse,
  MonitoringResourceEntry,
  MonitoringResourceUtilizationResponse,
  MonitoringSeriesResponse,
  MonitoringTracesResponse,
} from './monitoring.types';

export async function get_series(
  workflow_id: string,
  query: GridQuery
): Promise<MonitoringSeriesResponse> {
  const { bucket_seconds, bucket_start_ats, ...values } = await withTimeZone(query, () =>
    monitoring_repo.series(workflow_id, query)
  );
  return {
    workflow_id,
    from: query.from,
    to: query.to,
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

// The grid opens on the first bucket anything was measured in, so a chart does not start on a run
// of empty buckets. A range with no readings at all keeps its full grid.
export async function get_resource_utilization(
  workflow_id: string,
  query: GridQuery
): Promise<MonitoringResourceUtilizationResponse> {
  const row = await withTimeZone(query, () =>
    monitoring_repo.resource_utilization(workflow_id, query)
  );
  const leading = leading_empty_buckets([...row.machines, ...row.agents]);
  return {
    workflow_id,
    from: query.from,
    to: query.to,
    bucket_seconds: row.bucket_seconds,
    bucket_start_ats: row.bucket_start_ats.slice(leading),
    machines: drop_buckets(row.machines, leading),
    agents: drop_buckets(row.agents, leading),
  };
}

export async function get_error_summary(
  workflow_id: string,
  query: TimeRange
): Promise<MonitoringErrorSummaryResponse> {
  const row = await monitoring_repo.error_summary(workflow_id, query);
  return { workflow_id, from: query.from, to: query.to, ...row };
}

/** The agents and replicas that wrote logs in the range, each agent with its id. */
async function log_sources(workflow_id: string, range: TimeRange): Promise<MonitoringLogSource[]> {
  const sources = await monitoring_repo.log_sources(workflow_id, range);
  return sources.map((source) => ({
    agent_id: Bun.randomUUIDv5(source.agent, workflow_id),
    ...source,
  }));
}

export async function get_logs(
  workflow_id: string,
  query: MonitoringLogsQuery
): Promise<MonitoringLogsResponse> {
  // The filter gives an agent's id and a log carries its name; an id no log's agent has keeps none.
  const sources = query.agent_id === undefined ? [] : await log_sources(workflow_id, query);
  const agent = sources.find(({ agent_id }) => agent_id === query.agent_id)?.agent;
  return {
    workflow_id,
    from: query.from,
    to: query.to,
    logs:
      query.agent_id !== undefined && agent === undefined
        ? []
        : await monitoring_repo.logs(workflow_id, query, agent),
  };
}

export async function get_llm_calls(
  workflow_id: string,
  query: MonitoringListQuery
): Promise<MonitoringLlmCallsResponse> {
  return {
    workflow_id,
    from: query.from,
    to: query.to,
    calls: await monitoring_repo.llm_calls(workflow_id, query),
  };
}

export async function get_traces(
  workflow_id: string,
  query: MonitoringListQuery
): Promise<MonitoringTracesResponse> {
  return {
    workflow_id,
    from: query.from,
    to: query.to,
    traces: await monitoring_repo.traces(workflow_id, query),
  };
}

export async function get_log_sources(
  workflow_id: string,
  query: TimeRange
): Promise<MonitoringLogSourcesResponse> {
  return {
    workflow_id,
    from: query.from,
    to: query.to,
    sources: await log_sources(workflow_id, query),
  };
}

export async function get_replicas(workflow_id: string): Promise<MonitoringReplicasResponse> {
  return { workflow_id, replicas: await monitoring_repo.replicas(workflow_id) };
}

const EXAMPLE_ARGUMENT_VALUE = 'your query';

/** The endpoint as the workflow sees it: the routes of its workflow only. */
function describe_endpoint(address: EndpointAddress, workflow_id: string): MonitoringEndpoint {
  return {
    status_url: `http://${address.public_host}:${address.api_port}/status`,
    routes: address.routes
      .filter((route) => route.workflow_id === workflow_id)
      .map((route) => ({
        ...route,
        example_body: Object.fromEntries(
          route.arguments.map((name) => [name, EXAMPLE_ARGUMENT_VALUE])
        ),
      })),
  };
}

// The controller records its endpoint's address only while it runs one.
export async function get_endpoint(workflow_id: string): Promise<MonitoringEndpointResponse> {
  return with_redis(workflow_id, async (redis) => {
    await assert_workflow_running(redis, workflow_id);
    const address = await monitoring_repo.endpoint(redis);
    return { workflow_id, endpoint: address ? describe_endpoint(address, workflow_id) : null };
  });
}
