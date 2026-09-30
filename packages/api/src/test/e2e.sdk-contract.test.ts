import { describe, expect, test } from 'bun:test';

import type { MetricsBlocks, MetricsKpis } from '@canyonos/api/metrics';
import type { ProjectStats, ProjectSummary } from '@canyonos/api/projects';
import type { RequestList } from '@canyonos/api/requests';
import type { FleetOverview } from '@canyonos/api/resources';

import { api, setupE2ETests } from './e2e.setup';
import { authenticate, bearer, create_test_project } from './project-test.utils';

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
});
