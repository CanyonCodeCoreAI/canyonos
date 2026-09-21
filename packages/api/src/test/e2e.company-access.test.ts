import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  clear_workflow_generation_mock,
  set_workflow_generation_mock,
} from '../modules/workflows/workflows.generation.testkit';
import { workflows_queue } from '../modules/workflows/workflows.queue';
import { api, setupE2ETests } from './e2e.setup';
import {
  add_company_member,
  authenticate,
  bearer,
  create_deploy_setup,
} from './project-test.utils';
import type {
  WorkflowGeneratedDesignPayload,
  WorkflowGeneratedStatsPayload,
} from '../modules/workflows/workflows.types';

setupE2ETests();

const UPLOAD = {
  name: 'Shared Project',
  files: [
    { path: 'workflow.py', content: 'def run(req):\n    return req\n' },
    { path: 'agents/router.agent.py', content: '# router\n' },
  ],
};

const mock_design = (source_path: string): WorkflowGeneratedDesignPayload => ({
  nodes: [
    {
      id: 'entry',
      position: { x: 0, y: 0 },
      data: { kind: 'workflow', file: source_path, role: 'Entry', tag: 'Entry', chips: [] },
    },
  ],
  edges: [],
});

const mock_stats = (source_path: string): WorkflowGeneratedStatsPayload => ({
  name: 'Shared Project',
  workflow_file: source_path,
  summary: `Generated from ${source_path}`,
  stats: [
    { id: 'components', label: 'Components', value: 1, caption: 'workflow', accent: 'workflow' },
  ],
});

// A company owner, a teammate who joins that same company, and a user from an unrelated company.
// The owner creates everything and the other two create nothing: access resolving to the install
// rather than to the creator or the company is exactly what this exercises.
let owner_token: string;
let mate_token: string;
let other_company_token: string;
let project_id: string;
let workflow_id: string;
let file_id: string;

describe('install-wide access to projects, files, workflows, and deploy', () => {
  beforeAll(async () => {
    set_workflow_generation_mock(async (input) => ({
      status: 'ready',
      design: mock_design(input.source_path),
      stats: mock_stats(input.source_path),
    }));

    owner_token = await authenticate('access-owner@canyonos.test');
    mate_token = await add_company_member(owner_token, 'access-mate@canyonos.test');
    other_company_token = await authenticate('access-outsider@canyonos.test');

    const created = await api.projects.post(UPLOAD, { headers: bearer(owner_token) });
    expect(created.error).toBeNull();
    project_id = created.data!.project.id;
    workflow_id = created.data!.workflows[0]!.id;
    await workflows_queue.idle();

    const files = await api.projects[project_id]!.files.get({ $headers: bearer(owner_token) });
    file_id = files.data!.find((file) => file.path === 'workflow.py')!.id;

    await create_deploy_setup(owner_token);
  });

  afterAll(() => clear_workflow_generation_mock());

  test('a teammate lists the project they did not create', async () => {
    const list = await api.projects.get({ $headers: bearer(mate_token) });
    expect(list.error).toBeNull();
    expect(list.data?.some((project) => project.id === project_id)).toBe(true);
  });

  test('a teammate reads the project detail and file tree', async () => {
    const detail = await api.projects[project_id]!.get({ $headers: bearer(mate_token) });
    expect(detail.error).toBeNull();
    expect(detail.data?.id).toBe(project_id);

    const files = await api.projects[project_id]!.files.get({ $headers: bearer(mate_token) });
    expect(files.error).toBeNull();
    expect(files.data?.length).toBe(2);
  });

  test('a teammate reads and edits a file they did not create', async () => {
    const file = await api.projects[project_id]!.files[file_id]!.get({
      $headers: bearer(mate_token),
    });
    expect(file.error).toBeNull();
    expect(file.data?.content).toBe('def run(req):\n    return req\n');

    const patched = await api.projects[project_id]!.files[file_id]!.patch(
      { content: 'print("teammate edit")\n' },
      { headers: bearer(mate_token) }
    );
    expect(patched.error).toBeNull();
    expect(patched.data?.content).toBe('print("teammate edit")\n');
    await workflows_queue.idle();
  });

  test('a teammate reads workflow design, project stats, and deploy config', async () => {
    const design = await api.projects[project_id]!.workflows[workflow_id]!.design.get({
      $headers: bearer(mate_token),
    });
    expect(design.error).toBeNull();
    expect(design.data?.project_id).toBe(project_id);

    const stats = await api.projects[project_id]!.stats.get({ $headers: bearer(mate_token) });
    expect(stats.error).toBeNull();

    const deploy = await api.projects[project_id]!.deploy.config.get({
      $headers: bearer(mate_token),
    });
    expect(deploy.error).toBeNull();
    expect(deploy.data?.project_name).toBe('Shared Project');
  });

  test('a user from another company reads every resource', async () => {
    const read = { $headers: bearer(other_company_token) };

    const detail = await api.projects[project_id]!.get(read);
    expect(detail.data?.id).toBe(project_id);

    const files = await api.projects[project_id]!.files.get(read);
    expect(files.data?.length).toBe(2);

    const file = await api.projects[project_id]!.files[file_id]!.get(read);
    expect(file.error).toBeNull();

    const design = await api.projects[project_id]!.workflows[workflow_id]!.design.get(read);
    expect(design.data?.project_id).toBe(project_id);

    const stats = await api.projects[project_id]!.stats.get(read);
    expect(stats.error).toBeNull();

    // The deploy setup belongs to the owner company, and the project resolves it, not the caller.
    const deploy = await api.projects[project_id]!.deploy.config.get(read);
    expect(deploy.data?.project_name).toBe('Shared Project');
  });

  test('a user from another company edits a file they did not create', async () => {
    const patched = await api.projects[project_id]!.files[file_id]!.patch(
      { content: 'print("edited from another company")\n' },
      { headers: bearer(other_company_token) }
    );
    expect(patched.error).toBeNull();
    expect(patched.data?.content).toBe('print("edited from another company")\n');
    await workflows_queue.idle();
  });

  test('a user from another company sees the project in their own list', async () => {
    const list = await api.projects.get({ $headers: bearer(other_company_token) });
    expect(list.error).toBeNull();
    expect(list.data?.some((project) => project.id === project_id)).toBe(true);
  });
});
