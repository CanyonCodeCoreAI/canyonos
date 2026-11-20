// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test';

import type { MetricsBlocks, MetricsKpis } from '@canyonos/api/metrics';
import type {
  MonitoringErrorSummaryResponse,
  MonitoringLlmCallsResponse,
  MonitoringLogSourcesResponse,
  MonitoringLogsResponse,
  MonitoringReplicasResponse,
  MonitoringResourceUtilizationResponse,
  MonitoringSeriesResponse,
  MonitoringTracesResponse,
} from '@canyonos/api/monitoring';
import type { Prompt, PromptListItem, SystemPrompt } from '@canyonos/api/prompts';
import type { RequestList } from '@canyonos/api/requests';
import type { FleetOverview } from '@canyonos/api/resources';
import type {
  ScalingAgentsResponse,
  ScalingDeleteResponse,
  ScalingPolicy,
  ScalingResponse,
} from '@canyonos/api/scaling';
import type { WorkflowSummary } from '@canyonos/api/workflows';

import { api, group_workflow, setupE2ETests } from './e2e.setup';
import {
  reconcile_prompts_now,
  seed_running_workflow,
  seed_scaling,
  seed_scaling_agents,
} from './redis-test.utils';
import { bearer, create_test_workflow, TEST_API_KEY } from './workflow-test.utils';

setupE2ETests();

const key_headers = bearer(TEST_API_KEY);

describe('SDK contract', () => {
  test('healthz round-trip preserves shape', async () => {
    const { data, error } = await api.v1.healthz.get();
    expect(error).toBeNull();
    if (!data) throw new Error('healthz returned no data');
    expect(typeof data.status).toBe('string');
    expect(typeof data.version).toBe('string');
    expect(typeof data.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(data.timestamp))).toBe(false);
  });

  test('workflow, requests, metrics, and resources endpoints are typed at runtime', async () => {
    const token = TEST_API_KEY;
    const headers = bearer(token);
    const { workflow_id } = await create_test_workflow({ name: 'SDK Workflow' });
    const range = {
      from: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      to: new Date().toISOString(),
    };

    const workflows: WorkflowSummary[] = (await api.v1.workflows.get({ $headers: headers })).data!;
    const workflow: WorkflowSummary = (
      await api.v1.workflows[workflow_id]!.get({ $headers: headers })
    ).data!;
    const requests: RequestList = (
      await group_workflow(workflow_id).requests.get({
        $query: { ...range, limit: 20, offset: 0 },
        $headers: headers,
      })
    ).data!;
    const kpis: MetricsKpis = (
      await group_workflow(workflow_id).metrics.kpis.get({ $query: range, $headers: headers })
    ).data!;
    const blocks: MetricsBlocks = (
      await group_workflow(workflow_id).metrics.blocks.get({
        $query: range,
        $headers: headers,
      })
    ).data!;
    const overview: FleetOverview = (
      await api.v1.resources.overview.get({
        $query: {
          from: new Date(Date.now() - 7 * 86_400_000).toISOString(),
          to: new Date().toISOString(),
        },
        $headers: headers,
      })
    ).data!;

    expect(workflows.some(({ id }) => id === workflow_id)).toBe(true);
    expect(workflow).toMatchObject({ id: workflow_id, name: 'SDK Workflow' });
    expect(requests.total).toBe(0);
    expect(kpis.workflow_id).toBe(workflow_id);
    expect(blocks.workflow_id).toBe(workflow_id);
    expect(overview.workflows.some(({ id }) => id === workflow_id)).toBe(true);
  });

  test('monitoring endpoints are typed at runtime', async () => {
    const token = TEST_API_KEY;
    const headers = bearer(token);
    const { workflow_id } = await create_test_workflow({ name: 'SDK Monitoring' });
    const monitoring = group_workflow(workflow_id).monitoring;
    // On the hour, so the hourly grid has exactly 24 whole buckets rather than two partial ends.
    const to_ms = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const range = {
      from: new Date(to_ms - 24 * 3_600_000).toISOString(),
      to: new Date(to_ms).toISOString(),
    };
    const list = { ...range, limit: 200 };

    const series: MonitoringSeriesResponse = (
      await monitoring.series.get({ $query: range, $headers: headers })
    ).data!;
    const logs: MonitoringLogsResponse = (
      await monitoring.logs.get({ $query: { ...list, errors_only: false }, $headers: headers })
    ).data!;
    const sources: MonitoringLogSourcesResponse = (
      await monitoring.logs.sources.get({ $query: range, $headers: headers })
    ).data!;
    const calls: MonitoringLlmCallsResponse = (
      await monitoring.llm.get({ $query: list, $headers: headers })
    ).data!;
    const traces: MonitoringTracesResponse = (
      await monitoring.traces.get({ $query: list, $headers: headers })
    ).data!;
    const errors: MonitoringErrorSummaryResponse = (
      await monitoring.errors.summary.get({ $query: range, $headers: headers })
    ).data!;
    const resources: MonitoringResourceUtilizationResponse = (
      await monitoring.resources.get({ $query: range, $headers: headers })
    ).data!;
    const replicas: MonitoringReplicasResponse = (
      await monitoring.replicas.get({ $headers: headers })
    ).data!;

    const scope = { workflow_id, ...range } as const;
    expect(series).toMatchObject({ ...scope, bucket_seconds: 3600 });
    expect(series.series.map(({ signal, samples }) => [signal, samples])).toEqual([
      ['traffic', 24],
      ['errors', 24],
      ['latency', 0],
      ['saturation', 0],
    ]);
    expect(logs).toEqual({ ...scope, logs: [] });
    expect(sources).toEqual({ ...scope, sources: [] });
    expect(calls).toEqual({ ...scope, calls: [] });
    expect(traces).toEqual({ ...scope, traces: [] });
    expect(errors).toEqual({ ...scope, total: 0, by_type: [], by_agent: [] });
    expect(resources).toMatchObject({ ...scope, machines: [], agents: [] });
    expect(resources.bucket_start_ats).toHaveLength(24);
    expect(replicas).toEqual({ workflow_id, replicas: [] });
  });

  test('prompt endpoints are typed at runtime', async () => {
    const token = TEST_API_KEY;
    const headers = bearer(token);
    const { workflow_id } = await create_test_workflow({ name: 'SDK Prompts' });
    await seed_running_workflow(workflow_id, {
      prompts: {
        'app.summarize': [
          {
            version: 'app-summarize-abcdef01-v1',
            content: 'Summarize the input.',
            updated_at: '2026-09-01T00:00:00.000Z',
          },
        ],
      },
    });
    await reconcile_prompts_now(workflow_id);

    const v1: SystemPrompt = {
      version: 'app-summarize-abcdef01-v1',
      content: 'Summarize the input.',
      updated_at: '2026-09-01T00:00:00.000Z',
    };
    const prompts: PromptListItem[] = (
      await group_workflow(workflow_id).prompts.get({ $headers: headers })
    ).data!;
    const created: SystemPrompt = (
      await group_workflow(workflow_id).prompts['app.summarize']!.versions.post(
        { content: 'Summarize briefly.' },
        { headers: key_headers }
      )
    ).data!;
    const prompt: Prompt = (
      await group_workflow(workflow_id).prompts['app.summarize']!.get({ $headers: headers })
    ).data!;
    const live: PromptListItem = (
      await group_workflow(workflow_id).prompts['app.summarize']!.live.put(
        { version: created.version },
        { headers: key_headers }
      )
    ).data!;

    expect(prompts).toEqual([{ name: 'app.summarize', live: v1 }]);
    expect(created.version).toMatch(/^app-summarize-[0-9a-f]{8}-v2$/);
    expect(created).toMatchObject({ content: 'Summarize briefly.' });
    expect(typeof created.updated_at).toBe('string');
    expect(prompt).toEqual({ name: 'app.summarize', live: v1, versions: [created, v1] });
    expect(live).toEqual({ name: 'app.summarize', live: created });
  });

  test('scaling endpoints are typed at runtime', async () => {
    const token = TEST_API_KEY;
    const headers = bearer(token);
    const { workflow_id } = await create_test_workflow({ name: 'SDK Scaling' });
    const policy: ScalingPolicy = {
      min_replicas: 1,
      max_replicas: 4,
      metric: 'queue_length_total',
      scale_up_above: 3,
      scale_down_below: 1,
    };
    await seed_running_workflow(workflow_id, { prompts: {} });
    await seed_scaling(JSON.stringify({ workflows: { app: policy } }));
    await seed_scaling_agents([{ name: 'app.PriceAgent', replicas: 1 }]);

    const scaling: ScalingResponse = (
      await group_workflow(workflow_id).scaling.get({ $headers: headers })
    ).data!;
    const agents: ScalingAgentsResponse = (
      await group_workflow(workflow_id).scaling.agents.get({ $headers: headers })
    ).data!;
    const saved: ScalingPolicy = (
      await group_workflow(workflow_id).scaling.put(
        { ...policy, metric: 'requests_per_minute_per_replica' },
        { headers: key_headers }
      )
    ).data!;

    expect(scaling).toEqual({ workflows: { app: { status: 'applied', policy } } });
    expect(agents).toEqual({
      agents: [
        {
          agent_id: Bun.randomUUIDv5('app.PriceAgent', workflow_id),
          name: 'app.PriceAgent',
          replicas_expected: 1,
          replicas_running: 0,
          load: null,
        },
      ],
    });
    expect(saved).toEqual({ ...policy, metric: 'requests_per_minute_per_replica' });

    const deleted: ScalingDeleteResponse = (
      await group_workflow(workflow_id).scaling.delete(undefined, { headers: key_headers })
    ).data!;
    expect(deleted).toEqual({ status: 'none' });
  });
});
