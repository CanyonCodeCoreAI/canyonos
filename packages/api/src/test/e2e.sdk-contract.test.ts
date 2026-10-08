import { describe, expect, test } from 'bun:test';

import type { MetricsBlocks, MetricsKpis } from '@canyonos/api/metrics';
import type {
  MonitoringErrorSummaryResponse,
  MonitoringLlmCallsResponse,
  MonitoringLogSourcesResponse,
  MonitoringLogsResponse,
  MonitoringResourceUtilizationResponse,
  MonitoringSeriesResponse,
  MonitoringTracesResponse,
} from '@canyonos/api/monitoring';
import type { ProjectStats, ProjectSummary } from '@canyonos/api/projects';
import type { Prompt, PromptListItem, SystemPrompt } from '@canyonos/api/prompts';
import type { RequestList } from '@canyonos/api/requests';
import type { FleetOverview } from '@canyonos/api/resources';
import type {
  ScalingAgentsResponse,
  ScalingDeleteResponse,
  ScalingPolicy,
  ScalingStatus,
} from '@canyonos/api/scaling';

import { load_prompts } from '../modules/prompts/prompts.service';
import { api, setupE2ETests } from './e2e.setup';
import { authenticate, bearer, create_test_project } from './project-test.utils';
import { seed_running_project, seed_scaling, seed_scaling_agents } from './redis-test.utils';

setupE2ETests();

describe('SDK contract', () => {
  test('healthz round-trip preserves shape', async () => {
    const { data, error } = await api.healthz.get();
    expect(error).toBeNull();
    if (!data) throw new Error('healthz returned no data');
    expect(typeof data.status).toBe('string');
    expect(typeof data.version).toBe('string');
    expect(typeof data.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(data.timestamp))).toBe(false);
  });

  test('project, stats, requests, metrics, and resources endpoints are typed at runtime', async () => {
    const token = await authenticate('sdk-project-contract@canyonos.test');
    const headers = bearer(token);
    const { project_id } = await create_test_project(token, {
      name: 'SDK Project',
      files: [{ path: 'workflow.py', component_kind: 'workflow' }],
    });

    const projects: ProjectSummary[] = (await api.projects.get({ $headers: headers })).data!;
    const project: ProjectSummary = (await api.projects[project_id]!.get({ $headers: headers }))
      .data!;
    const stats: ProjectStats = (await api.projects[project_id]!.stats.get({ $headers: headers }))
      .data!;
    const requests: RequestList = (
      await api.projects[project_id]!.requests.get({
        $query: { limit: 20, offset: 0 },
        $headers: headers,
      })
    ).data!;
    const kpis: MetricsKpis = (
      await api.projects[project_id]!.metrics.kpis.get({ $headers: headers })
    ).data!;
    const blocks: MetricsBlocks = (
      await api.projects[project_id]!.metrics.blocks.get({
        $query: { time_window: '30d' },
        $headers: headers,
      })
    ).data!;
    const overview: FleetOverview = (
      await api.resources.overview.get({ $query: { time_window: '7d' }, $headers: headers })
    ).data!;

    expect(projects.some(({ id }) => id === project_id)).toBe(true);
    expect(project).toMatchObject({ id: project_id, name: 'SDK Project', file_count: 1 });
    expect(stats).toMatchObject({ project_id, workflow_count: 1 });
    expect(requests.total).toBe(0);
    expect(kpis.project_id).toBe(project_id);
    expect(blocks.project_id).toBe(project_id);
    expect(overview.projects.some(({ id }) => id === project_id)).toBe(true);
  });

  test('monitoring endpoints are typed at runtime', async () => {
    const token = await authenticate('sdk-monitoring-contract@canyonos.test');
    const headers = bearer(token);
    const { project_id } = await create_test_project(token, { name: 'SDK Monitoring' });
    const monitoring = api.projects[project_id]!.monitoring;
    const window = { time_window: '1d' } as const;
    const list = { ...window, limit: 200 };

    const series: MonitoringSeriesResponse = (
      await monitoring.series.get({ $query: window, $headers: headers })
    ).data!;
    const logs: MonitoringLogsResponse = (
      await monitoring.logs.get({ $query: { ...list, errors_only: false }, $headers: headers })
    ).data!;
    const sources: MonitoringLogSourcesResponse = (
      await monitoring.logs.sources.get({ $query: window, $headers: headers })
    ).data!;
    const calls: MonitoringLlmCallsResponse = (
      await monitoring.llm.get({ $query: list, $headers: headers })
    ).data!;
    const traces: MonitoringTracesResponse = (
      await monitoring.traces.get({ $query: list, $headers: headers })
    ).data!;
    const errors: MonitoringErrorSummaryResponse = (
      await monitoring.errors.summary.get({ $query: window, $headers: headers })
    ).data!;
    const resources: MonitoringResourceUtilizationResponse = (
      await monitoring.resources.get({ $query: window, $headers: headers })
    ).data!;

    const scope = { project_id, time_window: '1d' } as const;
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
  });

  test('prompt endpoints are typed at runtime', async () => {
    const token = await authenticate('sdk-prompts-contract@canyonos.test');
    const headers = bearer(token);
    const { project_id } = await create_test_project(token, { name: 'SDK Prompts' });
    await seed_running_project(project_id, {
      prompts: {
        summarize: [
          {
            version: 'summarize-abcdef01-v1',
            content: 'Summarize the input.',
            updated_at: '2026-09-01T00:00:00.000Z',
          },
        ],
      },
    });
    await load_prompts(project_id);

    const v1: SystemPrompt = {
      version: 'summarize-abcdef01-v1',
      content: 'Summarize the input.',
      updated_at: '2026-09-01T00:00:00.000Z',
    };
    const prompts: PromptListItem[] = (
      await api.projects[project_id]!.prompts.get({ $headers: headers })
    ).data!;
    const created: SystemPrompt = (
      await api.projects[project_id]!.prompts.summarize!.versions.post(
        { content: 'Summarize briefly.' },
        { headers }
      )
    ).data!;
    const prompt: Prompt = (
      await api.projects[project_id]!.prompts.summarize!.get({ $headers: headers })
    ).data!;
    const live: PromptListItem = (
      await api.projects[project_id]!.prompts.summarize!.live.put(
        { version: created.version },
        { headers }
      )
    ).data!;

    expect(prompts).toEqual([{ name: 'summarize', live: v1 }]);
    expect(created.version).toMatch(/^summarize-[0-9a-f]{8}-v2$/);
    expect(created).toMatchObject({ content: 'Summarize briefly.' });
    expect(typeof created.updated_at).toBe('string');
    expect(prompt).toEqual({ name: 'summarize', live: v1, versions: [created, v1] });
    expect(live).toEqual({ name: 'summarize', live: created });
  });

  test('scaling endpoints are typed at runtime', async () => {
    const token = await authenticate('sdk-scaling-contract@canyonos.test');
    const headers = bearer(token);
    const { project_id } = await create_test_project(token, { name: 'SDK Scaling' });
    const policy: ScalingPolicy = {
      min_replicas: 1,
      max_replicas: 4,
      metric: 'queue_length_total',
      scale_up_above: 3,
      scale_down_below: 1,
    };
    await seed_running_project(project_id, { prompts: {} });
    await seed_scaling(JSON.stringify({ scaling: policy }));
    await seed_scaling_agents([{ name: 'PriceAgent', replicas: 1 }]);

    const scaling: ScalingStatus = (
      await api.projects[project_id]!.scaling.get({ $headers: headers })
    ).data!;
    const agents: ScalingAgentsResponse = (
      await api.projects[project_id]!.scaling.agents.get({ $headers: headers })
    ).data!;
    const saved: ScalingPolicy = (
      await api.projects[project_id]!.scaling.put(
        { ...policy, metric: 'requests_per_minute_per_replica' },
        { headers }
      )
    ).data!;

    expect(scaling).toEqual({ status: 'applied', policy });
    expect(agents).toEqual({
      agents: [{ name: 'PriceAgent', replicas_expected: 1, replicas_running: 0, load: null }],
    });
    expect(saved).toEqual({ ...policy, metric: 'requests_per_minute_per_replica' });

    const deleted: ScalingDeleteResponse = (
      await api.projects[project_id]!.scaling.delete(undefined, { headers })
    ).data!;
    expect(deleted).toEqual({ status: 'none' });
  });
});
