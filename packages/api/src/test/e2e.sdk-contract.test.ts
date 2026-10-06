import { describe, expect, test } from 'bun:test';

import type { MetricsBlocks, MetricsKpis } from '@canyonos/api/metrics';
import type { ProjectStats, ProjectSummary } from '@canyonos/api/projects';
import type { Prompt, PromptListItem, SystemPrompt } from '@canyonos/api/prompts';
import type { RequestList } from '@canyonos/api/requests';
import type { FleetOverview } from '@canyonos/api/resources';
import type { ScalingDeleteResponse, ScalingPolicy, ScalingResponse } from '@canyonos/api/scaling';

import { load_prompts } from '../modules/prompts/prompts.service';
import { api, setupE2ETests } from './e2e.setup';
import { authenticate, bearer, create_test_project } from './project-test.utils';
import { seed_running_project, seed_scaling } from './redis-test.utils';

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
      max_replicas: 3,
      metric: 'queue_length_total',
      scale_up_above: 4,
      scale_down_below: 1,
    };
    await seed_running_project(project_id, { prompts: {} });
    await seed_scaling(
      ['PriceAgent', 'RiskAgent'],
      JSON.stringify({ scaling: { PriceAgent: policy } })
    );

    const scaling: ScalingResponse = (
      await api.projects[project_id]!.scaling.get({ $headers: headers })
    ).data!;
    const saved: ScalingPolicy = (
      await api.projects[project_id]!.scaling.RiskAgent!.put(
        { ...policy, metric: 'requests_per_minute_per_replica' },
        { headers }
      )
    ).data!;

    expect(scaling).toEqual({
      agents: ['PriceAgent', 'RiskAgent'],
      policies: { PriceAgent: policy },
      invalid: [],
    });
    expect(saved).toEqual({ ...policy, metric: 'requests_per_minute_per_replica' });

    const deleted: ScalingDeleteResponse = (
      await api.projects[project_id]!.scaling.PriceAgent!.delete(undefined, { headers })
    ).data!;
    expect(deleted).toEqual({ agent_name: 'PriceAgent' });
  });
});
