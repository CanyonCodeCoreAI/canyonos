import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { asc, eq } from 'drizzle-orm';

import { db } from '@api/db/client';
import { deploymentEvents, deployments, otelSpans } from '@api/db/schema';
import { config } from '@core/env';

import { deployments_repo } from '../modules/deploy/deploy.repo';
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
import { write_project_span } from './telemetry-test.utils';

setupE2ETests();

beforeEach(() => {
  set_workflow_generation_mock(async () => ({
    status: 'failed',
    error_message: 'generation intentionally skipped in project tests',
  }));
});

afterEach(async () => {
  await workflows_queue.idle();
  clear_workflow_generation_mock();
});

const UPLOAD = {
  name: 'Demo Flow',
  files: [
    { path: 'workflow.py', content: 'def run(req):\n    return req\n' },
    { path: 'nested/second.py', content: '# ordinary agent file\n' },
    { path: 'nested/agent.py', content: '# agent\n' },
    { path: 'agents/router.agent.py', content: '# router\n' },
    { path: 'tools/tool.py', content: '# tool\n' },
    { path: 'tools/search.tool.py', content: '# search\n' },
    { path: 'README.md', content: '# demo\n' },
  ],
};

describe('project upload and files', () => {
  test('classifies any Python file with "workflow" in its name as a workflow', async () => {
    const token = await authenticate('project-classification@canyonos.test');
    const headers = bearer(token);
    const created = await api.projects.post(UPLOAD, { headers });

    expect(created.error).toBeNull();
    expect(created.data?.project.name).toBe('Demo Flow');
    expect(created.data?.project.file_count).toBe(7);
    expect(created.data?.workflows).toHaveLength(1);
    expect(created.data?.workflows[0]?.source_path).toBe('workflow.py');
    expect(created.data?.workflows[0]?.id).not.toBe(created.data?.project.id);

    const project_id = created.data!.project.id;
    const files = await api.projects[project_id]!.files.get({ $headers: headers });
    expect(files.error).toBeNull();
    expect(Object.fromEntries(files.data!.map((file) => [file.path, file.component_kind]))).toEqual(
      {
        'README.md': 'other',
        'agents/router.agent.py': 'agent',
        'nested/second.py': 'agent',
        'nested/agent.py': 'agent',
        'tools/search.tool.py': 'agent',
        'tools/tool.py': 'agent',
        'workflow.py': 'workflow',
      }
    );
    expect(files.data?.[0]).not.toHaveProperty('content');

    const source = files.data!.find(({ path }) => path === 'workflow.py')!;
    const content = await api.projects[project_id]!.files[source.id]!.get({ $headers: headers });
    expect(content.data?.component_kind).toBe('workflow');
    expect(content.data?.content).toContain('def run');
  });

  test('admits env files and stores their contents', async () => {
    const token = await authenticate('project-env-files@canyonos.test');
    const headers = bearer(token);
    const created = await api.projects.post(
      {
        name: 'Env Flow',
        files: [
          { path: 'workflow.py', content: 'def run(): pass\n' },
          { path: '.env', content: 'OPENAI_API_KEY=sk-test\n' },
          { path: 'service/.env.production', content: 'DB_URL=postgres://prod\n' },
        ],
      },
      { headers }
    );

    expect(created.error).toBeNull();
    const project_id = created.data!.project.id;
    const files = await api.projects[project_id]!.files.get({ $headers: headers });
    expect(Object.fromEntries(files.data!.map((file) => [file.path, file.component_kind]))).toEqual(
      {
        'workflow.py': 'workflow',
        '.env': 'other',
        'service/.env.production': 'other',
      }
    );

    const env = files.data!.find(({ path }) => path === '.env')!;
    const content = await api.projects[project_id]!.files[env.id]!.get({ $headers: headers });
    expect(content.data?.content).toBe('OPENAI_API_KEY=sk-test\n');
  });

  test('detects workflow sources by name anywhere and case-insensitively', async () => {
    const token = await authenticate('project-workflow-name@canyonos.test');
    const headers = bearer(token);
    const created = await api.projects.post(
      {
        name: 'Named Flows',
        files: [
          { path: 'portifolio_workflow.py', content: 'def run(): pass\n' },
          { path: 'nested/Sales.WORKFLOW.py', content: 'def run(): pass\n' },
          { path: 'helper.py', content: '# ordinary agent file\n' },
        ],
      },
      { headers }
    );

    expect(created.error).toBeNull();
    expect(created.data?.workflows.map(({ source_path }) => source_path).sort()).toEqual([
      'nested/Sales.WORKFLOW.py',
      'portifolio_workflow.py',
    ]);

    const project_id = created.data!.project.id;
    const files = await api.projects[project_id]!.files.get({ $headers: headers });
    expect(Object.fromEntries(files.data!.map((file) => [file.path, file.component_kind]))).toEqual(
      {
        'portifolio_workflow.py': 'workflow',
        'nested/Sales.WORKFLOW.py': 'workflow',
        'helper.py': 'agent',
      }
    );
  });

  test('lets a company member and a user from another company list, read, and edit a project', async () => {
    const owner = await authenticate('project-owner@canyonos.test');
    const created = await api.projects.post(UPLOAD, { headers: bearer(owner) });
    const project_id = created.data!.project.id;
    const source_file_id = created.data!.workflows[0]!.source_file_id;
    const member = await add_company_member(owner, 'project-member@canyonos.test');

    const list = await api.projects.get({ $headers: bearer(member) });
    expect(list.data?.some(({ id }) => id === project_id)).toBe(true);
    const detail = await api.projects[project_id]!.get({ $headers: bearer(member) });
    expect(detail.data?.id).toBe(project_id);
    const member_files = await api.projects[project_id]!.files.get({ $headers: bearer(member) });
    expect(member_files.data).toHaveLength(7);
    expect(
      (
        await api.projects[project_id]!.files[source_file_id]!.get({
          $headers: bearer(member),
        })
      ).data?.project_id
    ).toBe(project_id);
    const patched = await api.projects[project_id]!.files[source_file_id]!.patch(
      { content: 'def run():\n    return "shared"\n' },
      { headers: bearer(member) }
    );
    expect(patched.data?.content).toContain('shared');

    const other_company = await authenticate('project-outsider@canyonos.test');
    expect(
      (await api.projects.get({ $headers: bearer(other_company) })).data?.some(
        ({ id }) => id === project_id
      )
    ).toBe(true);
    expect(
      (await api.projects[project_id]!.get({ $headers: bearer(other_company) })).data?.id
    ).toBe(project_id);
    expect(
      (await api.projects[project_id]!.files.get({ $headers: bearer(other_company) })).data
    ).toHaveLength(7);
    expect(
      (
        await api.projects[project_id]!.files[source_file_id]!.get({
          $headers: bearer(other_company),
        })
      ).data?.id
    ).toBe(source_file_id);
    expect(
      (
        await api.projects[project_id]!.files[source_file_id]!.patch(
          { content: '# edited from another company\n' },
          { headers: bearer(other_company) }
        )
      ).data?.content
    ).toBe('# edited from another company\n');
    expect(
      (
        await api.projects[project_id]!.files[source_file_id]!.get({
          $headers: bearer(owner),
        })
      ).data?.content
    ).toBe('# edited from another company\n');
  });

  test('file PATCH rejects rename, reclassification, and unknown fields', async () => {
    const token = await authenticate('project-no-rename@canyonos.test');
    const headers = bearer(token);
    const created = await api.projects.post(UPLOAD, { headers });
    const project_id = created.data!.project.id;
    const source_file_id = created.data!.workflows[0]!.source_file_id;
    const invalid_fields = {
      path: 'renamed.agent.py',
      component_kind: 'agent',
      unexpected: true,
    };
    for (const [field, value] of Object.entries(invalid_fields)) {
      const response = await fetch(
        `${config.app.apiUrl}/projects/${project_id}/files/${source_file_id}`,
        {
          method: 'PATCH',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ content: '# rejected\n', [field]: value }),
        }
      );
      expect(response.status).toBe(422);
      expect(JSON.stringify(await response.json())).toContain(field);
    }

    const unchanged = await api.projects[project_id]!.files[source_file_id]!.get({
      $headers: headers,
    });
    expect(unchanged.data).toMatchObject({
      id: source_file_id,
      path: 'workflow.py',
      component_kind: 'workflow',
      content: 'def run(req):\n    return req\n',
    });
  });

  test('rejects file content containing a NUL byte on create and patch', async () => {
    const token = await authenticate('project-nul-content@canyonos.test');
    const headers = bearer(token);
    const nul_content = `head${String.fromCharCode(0)}tail`;

    const create = await api.projects.post(
      { name: 'Nul Create', files: [{ path: 'workflow.py', content: nul_content }] },
      { headers }
    );
    expect(create.error?.status as number).toBe(400);

    const created = await api.projects.post(UPLOAD, { headers });
    const project_id = created.data!.project.id;
    const source_file_id = created.data!.workflows[0]!.source_file_id;
    const patched = await api.projects[project_id]!.files[source_file_id]!.patch(
      { content: nul_content },
      { headers }
    );
    expect(patched.error?.status as number).toBe(400);

    const unchanged = await api.projects[project_id]!.files[source_file_id]!.get({
      $headers: headers,
    });
    expect(unchanged.data?.content).toBe('def run(req):\n    return req\n');
  });

  test('validates uploads and file identifiers', async () => {
    const token = await authenticate('project-validation@canyonos.test');
    const headers = bearer(token);
    expect((await api.projects.post({ name: 'Empty', files: [] }, { headers })).error?.status).toBe(
      422
    );
    expect(
      (
        await api.projects.post(
          { name: 'Unsafe', files: [{ path: '../evil.py', content: 'x' }] },
          { headers }
        )
      ).error?.status as number
    ).toBe(400);
    expect(
      (
        await api.projects.post(
          {
            name: 'Duplicate',
            files: [
              { path: 'workflow.py', content: 'a' },
              { path: 'workflow.py', content: 'b' },
            ],
          },
          { headers }
        )
      ).error?.status as number
    ).toBe(400);

    const created = await api.projects.post(UPLOAD, { headers });
    const project_id = created.data!.project.id;
    const missing = '00000000-0000-4000-8000-000000000000';
    expect(
      (await api.projects[project_id]!.files[missing]!.patch({ content: 'x' }, { headers })).error
        ?.status as number
    ).toBe(404);
  });

  test('rejects unauthenticated access', async () => {
    expect((await api.projects.get()).error?.status as number).toBe(401);
  });
});

describe('project deletion', () => {
  test('deletes a project and leaves its spans in place', async () => {
    const token = await authenticate('project-delete-spans@canyonos.test');
    const headers = bearer(token);
    const created = await api.projects.post(UPLOAD, { headers });
    await workflows_queue.idle();
    const project_id = created.data!.project.id;
    const span_id = 'project-delete-span';

    await write_project_span(project_id, { span_id });

    const deleted = await api.projects[project_id]!.delete({ $headers: headers });
    expect(deleted.error).toBeNull();
    expect(
      (await api.projects[project_id]!.get({ $headers: headers })).error?.status as number
    ).toBe(404);

    // otel_spans carries no foreign key to projects, so deletion cannot cascade to it. Every read
    // path scopes by a live project, which is what keeps the leftover rows unreachable.
    const surviving = await db
      .select({ span_id: otelSpans.span_id })
      .from(otelSpans)
      .where(eq(otelSpans.span_id, span_id));
    expect(surviving).toEqual([{ span_id }]);
  });

  test('deletes a project, deployments, and deployment events', async () => {
    const token = await authenticate('project-delete@canyonos.test');
    const headers = bearer(token);
    const created = await api.projects.post(UPLOAD, { headers });
    await workflows_queue.idle();
    const project_id = created.data!.project.id;
    const profile = await api.auth.profile.get({ $headers: headers });
    const company_id = profile.data?.company_id;
    const user_id = profile.data?.id;
    if (!company_id || !user_id) throw new Error('Project deletion fixture profile failed');
    const deploy_setup = await create_deploy_setup(token);
    const deployment = await deployments_repo.insert_pending_with_event(
      {
        project_id,
        company_id,
        created_by: user_id,
        deploy_setup_id: deploy_setup.id,
      },
      []
    );

    const events_before_delete = await db
      .select({ id: deploymentEvents.id })
      .from(deploymentEvents)
      .where(eq(deploymentEvents.deployment_id, deployment.id));
    expect(events_before_delete).toHaveLength(1);

    const deleted = await api.projects[project_id]!.delete({ $headers: headers });
    expect(deleted.error).toBeNull();

    expect(
      (await api.projects[project_id]!.get({ $headers: headers })).error?.status as number
    ).toBe(404);
    expect(
      (await api.projects[project_id]!.files.get({ $headers: headers })).error?.status as number
    ).toBe(404);
    expect(
      (await api.projects.get({ $headers: headers })).data?.some(({ id }) => id === project_id)
    ).toBe(false);

    const deployments_after_delete = await db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.id, deployment.id));
    const events_after_delete = await db
      .select({ id: deploymentEvents.id })
      .from(deploymentEvents)
      .where(eq(deploymentEvents.deployment_id, deployment.id))
      .orderBy(asc(deploymentEvents.seq));
    expect(deployments_after_delete).toHaveLength(0);
    expect(events_after_delete).toHaveLength(0);
  });

  test('returns 404 for an unknown project and leaves the known one intact', async () => {
    const token = await authenticate('project-delete-owner@canyonos.test');
    const created = await api.projects.post(UPLOAD, { headers: bearer(token) });
    await workflows_queue.idle();
    const project_id = created.data!.project.id;

    const unknown = '00000000-0000-4000-8000-000000000000';
    expect(
      (await api.projects[unknown]!.delete({ $headers: bearer(token) })).error?.status as number
    ).toBe(404);
    expect((await api.projects[project_id]!.get({ $headers: bearer(token) })).data?.id).toBe(
      project_id
    );
  });

  test('a user from another company deletes the project', async () => {
    const token = await authenticate('project-delete-owner2@canyonos.test');
    const created = await api.projects.post(UPLOAD, { headers: bearer(token) });
    await workflows_queue.idle();
    const project_id = created.data!.project.id;

    const other_company = await authenticate('project-delete-outsider@canyonos.test');
    expect(
      (await api.projects[project_id]!.delete({ $headers: bearer(other_company) })).error
    ).toBeNull();

    expect(
      (await api.projects[project_id]!.get({ $headers: bearer(token) })).error?.status as number
    ).toBe(404);
  });

  test('rejects unauthenticated project deletion', async () => {
    const token = await authenticate('project-delete-unauth@canyonos.test');
    const created = await api.projects.post(UPLOAD, { headers: bearer(token) });
    await workflows_queue.idle();
    expect((await api.projects[created.data!.project.id]!.delete()).error?.status as number).toBe(
      401
    );
  });
});
