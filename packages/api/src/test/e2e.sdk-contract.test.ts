import { afterEach, describe, expect, test } from 'bun:test';

import type {
  DeployConfig,
  DeploymentOverviewItem,
  ProjectDeployAccepted,
} from '@cc-forge/api/deploy';
import type { CreateProjectResult, ProjectStats, ProjectStatus } from '@cc-forge/api/projects';
import type {
  ProjectWorkflowDesign,
  ProjectWorkflowDetail,
  ProjectWorkflowSummary,
} from '@cc-forge/api/workflows';

import {
  clear_workflow_generation_mock,
  set_workflow_generation_mock,
} from '../modules/workflows/workflows.generation.testkit';
import { workflows_queue } from '../modules/workflows/workflows.queue';
import { api, setupE2ETests } from './e2e.setup';
import { authenticate, bearer, create_deploy_setup } from './project-test.utils';

setupE2ETests();

afterEach(async () => {
  await workflows_queue.idle();
  clear_workflow_generation_mock();
});

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

  test('nested project workflow, status, stats, and deploy endpoints are typed at runtime', async () => {
    const token = await authenticate('sdk-project-contract@cc-forge.test');
    await create_deploy_setup(token);
    const headers = bearer(token);
    set_workflow_generation_mock(async (input) => ({
      status: 'ready',
      design: { nodes: [], edges: [] },
      stats: {
        name: input.source_path,
        workflow_file: input.source_path,
        summary: 'SDK contract',
        stats: [],
      },
    }));

    const create_response = await api.projects.post(
      { name: 'SDK Project', files: [{ path: 'workflow.py', content: 'pass\n' }] },
      { headers }
    );
    const created: CreateProjectResult = create_response.data!;
    await workflows_queue.idle();
    const project_id = created.project.id;
    const workflow_id = created.workflows[0]!.id;

    const status: ProjectStatus = (
      await api.projects[project_id]!.status.get({ $headers: headers })
    ).data!;
    const stats: ProjectStats = (await api.projects[project_id]!.stats.get({ $headers: headers }))
      .data!;
    const workflows: ProjectWorkflowSummary[] = (
      await api.projects[project_id]!.workflows.get({ $headers: headers })
    ).data!;
    const detail: ProjectWorkflowDetail = (
      await api.projects[project_id]!.workflows[workflow_id]!.get({ $headers: headers })
    ).data!;
    const design: ProjectWorkflowDesign = (
      await api.projects[project_id]!.workflows[workflow_id]!.design.get({ $headers: headers })
    ).data!;
    const deploy_config: DeployConfig = (
      await api.projects[project_id]!.deploy.config.get({ $headers: headers })
    ).data!;
    const accepted: ProjectDeployAccepted = (
      await api.projects[project_id]!.deploy.post({}, { headers })
    ).data!;
    const overview: DeploymentOverviewItem = (
      await api.projects.deployments.get({ $query: { state: 'all', limit: 10 }, $headers: headers })
    ).data![0]!;

    expect(status.project_id).toBe(project_id);
    expect(stats.project_id).toBe(project_id);
    expect(workflows[0]?.id).toBe(workflow_id);
    expect(detail.id).toBe(workflow_id);
    expect(design.id).toBe(workflow_id);
    expect(deploy_config.project_id).toBe(project_id);
    expect(accepted).toMatchObject({ project_id, status: 'accepted' });
    expect(overview.project_id).toBe(project_id);
    expect(overview.project_name).toBe('SDK Project');
  });
});
