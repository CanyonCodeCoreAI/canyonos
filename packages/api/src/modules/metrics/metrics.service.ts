// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from '@core/errors';
import { withTimeZone } from '@core/time-range';
import type { GridQuery, TimeRange } from '@core/time-range';

import { metrics_repo } from './metrics.repo';
import type {
  DistributionQuery,
  MetricsAgentDetails,
  MetricsBlocks,
  MetricsDistribution,
  MetricsKpis,
  MetricsTimeseries,
} from './metrics.types';

export async function get_kpis(project_id: string, range: TimeRange): Promise<MetricsKpis> {
  return metrics_repo.kpis_by_project(project_id, range);
}

export async function get_distribution(
  project_id: string,
  query: DistributionQuery
): Promise<MetricsDistribution> {
  return metrics_repo.distribution_by_project(project_id, query.metric, query, query.buckets);
}

export async function get_timeseries(
  project_id: string,
  query: GridQuery
): Promise<MetricsTimeseries> {
  return withTimeZone(query, () => metrics_repo.timeseries_by_project(project_id, query));
}

export async function get_blocks(project_id: string, query: TimeRange): Promise<MetricsBlocks> {
  return metrics_repo.blocks_by_project(project_id, query);
}

export async function get_agent_details(
  project_id: string,
  agent_id: string,
  query: GridQuery
): Promise<MetricsAgentDetails> {
  const details = await withTimeZone(query, () =>
    metrics_repo.agent_details_by_project(project_id, agent_id, query)
  );
  if (!details) {
    throw notFound(
      'metrics.agent_not_found',
      `Agent "${agent_id}" has no telemetry data for this project in the selected range`
    );
  }
  return details;
}
