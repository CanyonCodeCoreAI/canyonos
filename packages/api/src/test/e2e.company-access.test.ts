import { beforeAll, describe, expect, test } from 'bun:test';

import { api, setupE2ETests } from './e2e.setup';
import {
  add_company_member,
  authenticate,
  bearer,
  create_test_project,
} from './project-test.utils';

setupE2ETests();

// A company owner, a teammate who joins that same company, and a user from an unrelated company.
// The owner creates everything and the other two create nothing: access resolving to the install
// rather than to the creator or the company is exactly what this exercises.
let owner_token: string;
let mate_token: string;
let other_company_token: string;
let project_id: string;

describe('install-wide access to projects', () => {
  beforeAll(async () => {
    owner_token = await authenticate('access-owner@canyonos.test');
    mate_token = await add_company_member(owner_token, 'access-mate@canyonos.test');
    other_company_token = await authenticate('access-outsider@canyonos.test');

    ({ project_id } = await create_test_project(owner_token, {
      name: 'Shared Project',
      files: [
        { path: 'workflow.py', component_kind: 'workflow' },
        { path: 'agents/router.agent.py', component_kind: 'agent' },
      ],
    }));
  });

  test('a teammate lists the project they did not create', async () => {
    const list = await api.projects.get({ $headers: bearer(mate_token) });
    expect(list.error).toBeNull();
    expect(list.data?.some((project) => project.id === project_id)).toBe(true);
  });

  test('a teammate reads the project detail and stats', async () => {
    const detail = await api.projects[project_id]!.get({ $headers: bearer(mate_token) });
    expect(detail.error).toBeNull();
    expect(detail.data?.id).toBe(project_id);
    expect(detail.data?.file_count).toBe(2);

    const stats = await api.projects[project_id]!.stats.get({ $headers: bearer(mate_token) });
    expect(stats.error).toBeNull();
    expect(stats.data?.workflow_count).toBe(1);
  });

  test('a user from another company reads every resource', async () => {
    const read = { $headers: bearer(other_company_token) };

    const detail = await api.projects[project_id]!.get(read);
    expect(detail.data?.id).toBe(project_id);

    const stats = await api.projects[project_id]!.stats.get(read);
    expect(stats.error).toBeNull();
    expect(stats.data?.file_count).toBe(2);
  });

  test('a user from another company sees the project in their own list', async () => {
    const list = await api.projects.get({ $headers: bearer(other_company_token) });
    expect(list.error).toBeNull();
    expect(list.data?.some((project) => project.id === project_id)).toBe(true);
  });
});
