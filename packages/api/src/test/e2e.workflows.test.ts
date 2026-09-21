import { afterEach, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';

import { db } from '@api/db/client';
import { files, projectWorkflows } from '@api/db/schema';
import { config } from '@core/env';

import {
  clear_workflow_generation_mock,
  set_workflow_generation_mock,
} from '../modules/workflows/workflows.generation.testkit';
import { workflows_queue } from '../modules/workflows/workflows.queue';
import { workflows_service } from '../modules/workflows/workflows.service';
import { api, setupE2ETests } from './e2e.setup';
import { add_company_member, authenticate, bearer } from './project-test.utils';
import type {
  WorkflowGeneratedDesignPayload,
  WorkflowGeneratedStatsPayload,
} from '../modules/workflows/workflows.types';

setupE2ETests();

afterEach(async () => {
  await workflows_queue.idle();
  clear_workflow_generation_mock();
});

const MULTI_UPLOAD = {
  name: 'Multi Router',
  files: [
    { path: 'workflow.py', content: 'def root(): pass\n' },
    { path: 'nested/order.workflow.py', content: 'def order(): pass\n' },
    { path: 'agents/router.agent.py', content: '# router\n' },
    { path: 'tools/search.tool.py', content: '# search\n' },
    { path: 'README.md', content: '# docs\n' },
  ],
};

function mock_design(source_path: string): WorkflowGeneratedDesignPayload {
  return {
    nodes: [
      {
        id: 'entry',
        position: { x: 0, y: 0 },
        data: {
          kind: 'workflow',
          file: source_path,
          role: 'Entry',
          tag: 'Entry',
          chips: [],
        },
      },
    ],
    edges: [],
  };
}

function mock_stats(source_path: string): WorkflowGeneratedStatsPayload {
  return {
    name: source_path,
    workflow_file: source_path,
    summary: `Generated from ${source_path}`,
    stats: [
      {
        id: 'components',
        label: 'Components',
        value: 1,
        caption: 'workflow',
        accent: 'workflow',
      },
    ],
  };
}

const successful_generation = async (input: { source_path: string }) => ({
  status: 'ready' as const,
  design: mock_design(input.source_path),
  stats: mock_stats(input.source_path),
});

type SuccessfulGenerationResult = Awaited<ReturnType<typeof successful_generation>>;

function generation_result(label: string, source_path: string): SuccessfulGenerationResult {
  return {
    status: 'ready',
    design: mock_design(source_path),
    stats: { ...mock_stats(source_path), name: label, summary: label },
  };
}

async function wait_for_count(values: readonly unknown[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (values.length === count) return;
    await Bun.sleep(5);
  }
  throw new Error(`Expected ${count} pending generation calls, received ${values.length}`);
}

async function expect_database_error(operation: Promise<unknown>): Promise<void> {
  let error: unknown;
  try {
    await operation;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeDefined();
}

async function create_multi_project(email: string) {
  const token = await authenticate(email);
  set_workflow_generation_mock(successful_generation);
  const created = await api.projects.post(MULTI_UPLOAD, { headers: bearer(token) });
  expect(created.error).toBeNull();
  await workflows_queue.idle();
  return { token, result: created.data! };
}

async function create_unbacked_workflow_source(email: string) {
  const token = await authenticate(email);
  const created = await api.projects.post(
    { name: 'Invariant Race', files: [{ path: 'source.py', content: 'pass\n' }] },
    { headers: bearer(token) }
  );
  const project_id = created.data!.project.id;
  const project_files = await api.projects[project_id]!.files.get({ $headers: bearer(token) });
  const source_file_id = project_files.data![0]!.id;
  await db
    .update(files)
    .set({ component_kind: 'workflow' })
    .where(and(eq(files.project_id, project_id), eq(files.id, source_file_id)));
  return { project_id, source_file_id };
}

describe('project-owned workflows', () => {
  test('creates, queues, lists, and designs multiple workflows with real child identities', async () => {
    const generated_sources: string[] = [];
    const token = await authenticate('workflow-multi@cc-forge.test');
    set_workflow_generation_mock(async (input) => {
      generated_sources.push(input.source_path);
      return successful_generation(input);
    });

    const created = await api.projects.post(MULTI_UPLOAD, { headers: bearer(token) });
    expect(created.error).toBeNull();
    const { project, workflows } = created.data!;
    expect(workflows.map(({ source_path }) => source_path)).toEqual([
      'workflow.py',
      'nested/order.workflow.py',
    ]);
    expect(workflows.every(({ id }) => id !== project.id)).toBe(true);
    await workflows_queue.idle();
    expect(generated_sources.sort()).toEqual(['nested/order.workflow.py', 'workflow.py']);

    const list = await api.projects[project.id]!.workflows.get({ $headers: bearer(token) });
    expect(list.error).toBeNull();
    expect(list.data).toHaveLength(2);
    expect(list.data?.every(({ status }) => status === 'READY')).toBe(true);
    for (const workflow of workflows) {
      const detail = await api.projects[project.id]!.workflows[workflow.id]!.get({
        $headers: bearer(token),
      });
      expect(detail.data).toMatchObject({
        id: workflow.id,
        project_id: workflow.project_id,
        source_file_id: workflow.source_file_id,
        source_path: workflow.source_path,
        status: 'READY',
      });
      expect(detail.data?.updated_at).toBeTruthy();
      const design = await api.projects[project.id]!.workflows[workflow.id]!.design.get({
        $headers: bearer(token),
      });
      expect(design.error).toBeNull();
      expect(design.data?.id).toBe(workflow.id);
      expect(design.data?.project_id).toBe(project.id);
      expect(design.data?.source_file_id).toBe(workflow.source_file_id);
      expect(design.data?.source_path).toBe(workflow.source_path);
      expect(design.data?.nodes[0]?.data.file).toBe(workflow.source_path);
      expect(design.data?.summary).toBe(`Generated from ${workflow.source_path}`);
      expect(design.data?.stats[0]?.value).toBe(1);
    }

    const status = await api.projects[project.id]!.status.get({ $headers: bearer(token) });
    expect(status.data).toMatchObject({ project_id: project.id, status: 'READY' });
    expect(status.data).not.toHaveProperty('id');
    const stats = await api.projects[project.id]!.stats.get({ $headers: bearer(token) });
    expect(stats.data).toEqual({
      project_id: project.id,
      file_count: 5,
      workflow_count: 2,
      ready_workflow_count: 2,
      agent_count: 2,
      tool_count: 0,
    });
  });

  test('generates a fresh design for every upload, including demo-named projects', async () => {
    const token = await authenticate('workflow-demo-cache@cc-forge.test');
    const headers = bearer(token);

    for (const demo_name of ['portfolio', 'text2sql']) {
      set_workflow_generation_mock(async (input) =>
        generation_result(`${demo_name} first graph`, input.source_path)
      );
      const template = await api.projects.post(
        {
          name: demo_name,
          files: [{ path: `${demo_name}_workflow.py`, content: 'def run(): pass\n' }],
        },
        { headers }
      );
      expect(template.error).toBeNull();
      await workflows_queue.idle();

      const generation_calls: string[] = [];
      set_workflow_generation_mock(async (input) => {
        generation_calls.push(input.project_name);
        return generation_result(`${demo_name} second graph`, input.source_path);
      });
      const next_name = `Customer ${demo_name.toUpperCase()} upload`;
      const copied = await api.projects.post(
        {
          name: next_name,
          files: [{ path: 'copied_workflow.py', content: 'def changed(): pass\n' }],
        },
        { headers }
      );
      expect(copied.error).toBeNull();
      // A demo-named upload is an upload like any other: PENDING on write, generated by the queue.
      expect(copied.data?.workflows[0]?.status).toBe('PENDING');
      await workflows_queue.idle();
      expect(generation_calls).toEqual([next_name]);

      const copied_project_id = copied.data!.project.id;
      const copied_workflow_id = copied.data!.workflows[0]!.id;
      const copied_design = await api.projects[copied_project_id]!.workflows[
        copied_workflow_id
      ]!.design.get({ $headers: headers });
      expect(copied_design.data).toMatchObject({
        name: `${demo_name} second graph`,
        source_path: 'copied_workflow.py',
      });
      expect(
        (await api.projects[copied_project_id]!.status.get({ $headers: headers })).data?.status
      ).toBe('READY');
    }
  });

  test('requires the correct project parent for workflow detail and design', async () => {
    const first = await create_multi_project('workflow-parent-a@cc-forge.test');
    const second = await api.projects.post(
      { ...MULTI_UPLOAD, name: 'Same Company Sibling' },
      { headers: bearer(first.token) }
    );
    await workflows_queue.idle();
    const workflow_id = first.result.workflows[0]!.id;

    const wrong_parent = await api.projects[second.data!.project.id]!.workflows[workflow_id]!.get({
      $headers: bearer(first.token),
    });
    expect(wrong_parent.error?.status as number).toBe(404);
    const wrong_design = await api.projects[second.data!.project.id]!.workflows[
      workflow_id
    ]!.design.get({ $headers: bearer(first.token) });
    expect(wrong_design.error?.status as number).toBe(404);
  });

  test('opens workflow, status, and stats to a teammate and to another company', async () => {
    const owner = await create_multi_project('workflow-company-owner@cc-forge.test');
    const project_id = owner.result.project.id;
    const workflow_id = owner.result.workflows[0]!.id;
    const member = await add_company_member(owner.token, 'workflow-company-member@cc-forge.test');

    expect(
      (
        await api.projects[project_id]!.workflows[workflow_id]!.design.get({
          $headers: bearer(member),
        })
      ).data?.id
    ).toBe(workflow_id);
    expect(
      (
        await api.projects[project_id]!.workflows[workflow_id]!.get({
          $headers: bearer(member),
        })
      ).data?.id
    ).toBe(workflow_id);
    expect(
      (await api.projects[project_id]!.workflows.get({ $headers: bearer(member) })).data
    ).toHaveLength(2);
    expect(
      (await api.projects[project_id]!.status.get({ $headers: bearer(member) })).data?.project_id
    ).toBe(project_id);
    expect(
      (await api.projects[project_id]!.stats.get({ $headers: bearer(member) })).data?.project_id
    ).toBe(project_id);

    const other_company = await authenticate('workflow-company-outsider@cc-forge.test');
    expect(
      (
        await api.projects[project_id]!.workflows[workflow_id]!.get({
          $headers: bearer(other_company),
        })
      ).data?.id
    ).toBe(workflow_id);
    expect(
      (
        await api.projects[project_id]!.workflows[workflow_id]!.design.get({
          $headers: bearer(other_company),
        })
      ).data?.id
    ).toBe(workflow_id);
    expect(
      (await api.projects[project_id]!.workflows.get({ $headers: bearer(other_company) })).data
    ).toHaveLength(2);
    expect(
      (await api.projects[project_id]!.status.get({ $headers: bearer(other_company) })).data
        ?.project_id
    ).toBe(project_id);
    expect(
      (await api.projects[project_id]!.stats.get({ $headers: bearer(other_company) })).data
        ?.project_id
    ).toBe(project_id);
  });

  test('applies zero, pending, stale, failed, and ready project-status precedence', async () => {
    const token = await authenticate('workflow-status@cc-forge.test');
    const headers = bearer(token);
    set_workflow_generation_mock(successful_generation);
    const empty = await api.projects.post(
      { name: 'No Workflow', files: [{ path: 'README.md', content: '# none\n' }] },
      { headers }
    );
    expect(
      (await api.projects[empty.data!.project.id]!.status.get({ $headers: headers })).data
    ).toMatchObject({
      status: 'FAILED',
      error_message: 'No workflow source files were found',
    });

    const created = await api.projects.post(MULTI_UPLOAD, { headers });
    await workflows_queue.idle();
    const project_id = created.data!.project.id;
    const [first, second] = created.data!.workflows;

    await db
      .update(projectWorkflows)
      .set({ generation_status: 'FAILED', error_message: 'second failed', stale_at: null })
      .where(eq(projectWorkflows.id, second!.id));
    await db
      .update(projectWorkflows)
      .set({ generation_status: 'PENDING', stale_at: null })
      .where(eq(projectWorkflows.id, first!.id));
    expect((await api.projects[project_id]!.status.get({ $headers: headers })).data?.status).toBe(
      'PENDING'
    );

    const mixed = await api.projects[project_id]!.workflows.get({ $headers: headers });
    const status_by_id = new Map(mixed.data!.map(({ id, status }) => [id, status]));
    expect(status_by_id.get(first!.id)).toBe('PENDING');
    expect(status_by_id.get(second!.id)).toBe('FAILED');

    await db
      .update(projectWorkflows)
      .set({ generation_status: 'READY', stale_at: new Date().toISOString() })
      .where(eq(projectWorkflows.id, first!.id));
    expect((await api.projects[project_id]!.status.get({ $headers: headers })).data?.status).toBe(
      'PENDING'
    );
    const stale_ready = await api.projects[project_id]!.workflows.get({ $headers: headers });
    expect(stale_ready.data?.find(({ id }) => id === first!.id)?.status).toBe('PENDING');

    await db
      .update(projectWorkflows)
      .set({ stale_at: null })
      .where(eq(projectWorkflows.id, first!.id));
    const failed = await api.projects[project_id]!.status.get({ $headers: headers });
    expect(failed.data).toMatchObject({ status: 'FAILED', error_message: 'second failed' });

    await db
      .update(projectWorkflows)
      .set({ generation_status: 'READY', error_message: null })
      .where(eq(projectWorkflows.id, second!.id));
    expect((await api.projects[project_id]!.status.get({ $headers: headers })).data?.status).toBe(
      'READY'
    );
  });

  test('a failed generation with no design is never reported ready', async () => {
    const token = await authenticate('workflow-missing-design@cc-forge.test');
    const headers = bearer(token);
    set_workflow_generation_mock(async () => ({
      status: 'failed',
      error_message: 'generation failed',
    }));
    const created = await api.projects.post(
      { name: 'Missing Design', files: [{ path: 'workflow.py', content: 'pass\n' }] },
      { headers }
    );
    await workflows_queue.idle();
    const project_id = created.data!.project.id;
    const workflow_id = created.data!.workflows[0]!.id;

    expect((await api.projects[project_id]!.status.get({ $headers: headers })).data).toMatchObject({
      status: 'FAILED',
      error_message: 'generation failed',
    });
    expect(
      (await api.projects[project_id]!.stats.get({ $headers: headers })).data?.ready_workflow_count
    ).toBe(0);
    expect(
      (
        await api.projects[project_id]!.workflows[workflow_id]!.design.get({
          $headers: headers,
        })
      ).error?.status as number
    ).toBe(404);
    await expect_database_error(
      Promise.resolve(
        db
          .update(projectWorkflows)
          .set({ generation_status: 'READY', design: null })
          .where(eq(projectWorkflows.id, workflow_id))
      )
    );
  });

  test('an unexpected initial generation throw finalizes the claimed revision as failed', async () => {
    const token = await authenticate('workflow-initial-throw@cc-forge.test');
    const headers = bearer(token);
    set_workflow_generation_mock(async () => {
      throw new Error('initial generator crash');
    });
    const created = await api.projects.post(
      { name: 'Initial Throw', files: [{ path: 'workflow.py', content: 'pass\n' }] },
      { headers }
    );
    await workflows_queue.idle();
    const project_id = created.data!.project.id;
    const workflow_id = created.data!.workflows[0]!.id;

    const [workflow] = await db
      .select({
        generation_status: projectWorkflows.generation_status,
        generation_revision: projectWorkflows.generation_revision,
        design: projectWorkflows.design,
        error_message: projectWorkflows.error_message,
      })
      .from(projectWorkflows)
      .where(eq(projectWorkflows.id, workflow_id));
    expect(workflow).toMatchObject({
      generation_status: 'FAILED',
      generation_revision: 1,
      design: null,
      error_message: 'Unexpected workflow generation failure',
    });
    expect((await api.projects[project_id]!.status.get({ $headers: headers })).data).toMatchObject({
      status: 'FAILED',
      error_message: 'Unexpected workflow generation failure',
    });
  });

  test('an unexpected regeneration throw preserves the last-good design and fails the project', async () => {
    const token = await authenticate('workflow-regeneration-throw@cc-forge.test');
    const headers = bearer(token);
    set_workflow_generation_mock(successful_generation);
    const created = await api.projects.post(
      { name: 'Regeneration Throw', files: [{ path: 'workflow.py', content: 'pass\n' }] },
      { headers }
    );
    await workflows_queue.idle();
    const project_id = created.data!.project.id;
    const workflow = created.data!.workflows[0]!;
    const [before] = await db
      .select({
        generation_revision: projectWorkflows.generation_revision,
        design: projectWorkflows.design,
      })
      .from(projectWorkflows)
      .where(eq(projectWorkflows.id, workflow.id));

    set_workflow_generation_mock(async () => {
      throw new Error('regeneration generator crash');
    });
    await api.projects[project_id]!.files[workflow.source_file_id]!.patch(
      { content: 'changed\n' },
      { headers }
    );
    await workflows_queue.idle();

    const [after] = await db
      .select({
        generation_status: projectWorkflows.generation_status,
        generation_revision: projectWorkflows.generation_revision,
        design: projectWorkflows.design,
        error_message: projectWorkflows.error_message,
      })
      .from(projectWorkflows)
      .where(eq(projectWorkflows.id, workflow.id));
    expect(after).toMatchObject({
      generation_status: 'FAILED',
      generation_revision: (before?.generation_revision ?? 0) + 1,
      design: before?.design,
      error_message: 'Unexpected workflow generation failure',
    });
    expect((await api.projects[project_id]!.status.get({ $headers: headers })).data).toMatchObject({
      status: 'FAILED',
      error_message: 'Unexpected workflow generation failure',
    });
  });

  test('a concurrent regenerate never steals a healthy in-flight generation', async () => {
    const { token, result } = await create_multi_project('workflow-inflight-noop@cc-forge.test');
    const headers = bearer(token);
    const project_id = result.project.id;
    const workflow = result.workflows[0]!;
    const [before] = await db
      .select({ generation_revision: projectWorkflows.generation_revision })
      .from(projectWorkflows)
      .where(eq(projectWorkflows.id, workflow.id));
    await db
      .update(projectWorkflows)
      .set({ stale_at: new Date().toISOString() })
      .where(eq(projectWorkflows.id, workflow.id));

    const completions: Array<(result: SuccessfulGenerationResult) => void> = [];
    set_workflow_generation_mock(
      () =>
        new Promise<SuccessfulGenerationResult>((resolve) => {
          completions.push(resolve);
        })
    );
    const inflight = workflows_service.regenerate(project_id, workflow.id);
    await wait_for_count(completions, 1);

    // The row is now GENERATING with no stale lease. A concurrent regenerate must refuse to claim it,
    // so no second generation starts and the revision is not bumped.
    await workflows_service.regenerate(project_id, workflow.id);
    expect(completions).toHaveLength(1);
    const [midway] = await db
      .select({
        generation_status: projectWorkflows.generation_status,
        generation_revision: projectWorkflows.generation_revision,
      })
      .from(projectWorkflows)
      .where(eq(projectWorkflows.id, workflow.id));
    expect(midway?.generation_status).toBe('GENERATING');
    expect(midway?.generation_revision).toBe((before?.generation_revision ?? 0) + 1);

    completions[0]!(generation_result('in-flight design', workflow.source_path));
    await inflight;

    const design = await api.projects[project_id]!.workflows[workflow.id]!.design.get({
      $headers: headers,
    });
    expect(design.data?.name).toBe('in-flight design');
    expect(design.data?.summary).toBe('in-flight design');
    const [after] = await db
      .select({ generation_revision: projectWorkflows.generation_revision })
      .from(projectWorkflows)
      .where(eq(projectWorkflows.id, workflow.id));
    expect(after?.generation_revision).toBe((before?.generation_revision ?? 0) + 1);
  });

  test('an in-flight generation that throws finalizes FAILED despite a concurrent regenerate', async () => {
    const token = await authenticate('workflow-inflight-throw@cc-forge.test');
    const headers = bearer(token);
    set_workflow_generation_mock(successful_generation);
    const created = await api.projects.post(
      { name: 'In-flight Throw', files: [{ path: 'workflow.py', content: 'pass\n' }] },
      { headers }
    );
    await workflows_queue.idle();
    const project_id = created.data!.project.id;
    const workflow = created.data!.workflows[0]!;
    const [before] = await db
      .select({ generation_revision: projectWorkflows.generation_revision })
      .from(projectWorkflows)
      .where(eq(projectWorkflows.id, workflow.id));
    await db
      .update(projectWorkflows)
      .set({ stale_at: new Date().toISOString() })
      .where(eq(projectWorkflows.id, workflow.id));

    let reject_inflight: ((reason: Error) => void) | undefined;
    set_workflow_generation_mock(
      () =>
        new Promise<SuccessfulGenerationResult>((_resolve, reject) => {
          reject_inflight = reject;
        })
    );
    const inflight = workflows_service.regenerate(project_id, workflow.id);
    for (let attempt = 0; attempt < 100 && !reject_inflight; attempt += 1) await Bun.sleep(5);
    if (!reject_inflight) throw new Error('Generation claim did not start');

    await workflows_service.regenerate(project_id, workflow.id);
    reject_inflight(new Error('in-flight generator crash'));
    await inflight;

    const [after] = await db
      .select({
        generation_status: projectWorkflows.generation_status,
        generation_revision: projectWorkflows.generation_revision,
        error_message: projectWorkflows.error_message,
      })
      .from(projectWorkflows)
      .where(eq(projectWorkflows.id, workflow.id));
    expect(after).toMatchObject({
      generation_status: 'FAILED',
      generation_revision: (before?.generation_revision ?? 0) + 1,
      error_message: 'Unexpected workflow generation failure',
    });
    expect((await api.projects[project_id]!.status.get({ $headers: headers })).data).toMatchObject({
      status: 'FAILED',
      error_message: 'Unexpected workflow generation failure',
    });
  });

  test('an older completion cannot consume a stale signal created after its claim', async () => {
    const { token, result } = await create_multi_project('workflow-revision-stale@cc-forge.test');
    const headers = bearer(token);
    const project_id = result.project.id;
    const workflow = result.workflows[0]!;
    await db
      .update(projectWorkflows)
      .set({ stale_at: new Date().toISOString() })
      .where(eq(projectWorkflows.id, workflow.id));

    let complete_old: ((result: SuccessfulGenerationResult) => void) | undefined;
    set_workflow_generation_mock(
      () =>
        new Promise<SuccessfulGenerationResult>((resolve) => {
          complete_old = resolve;
        })
    );
    const older = workflows_service.regenerate(project_id, workflow.id);
    for (let attempt = 0; attempt < 100 && !complete_old; attempt += 1) await Bun.sleep(5);
    if (!complete_old) throw new Error('Generation claim did not start');
    const newer_stale_at = new Date(Date.now() + 1_000).toISOString();
    await db
      .update(projectWorkflows)
      .set({ stale_at: newer_stale_at })
      .where(eq(projectWorkflows.id, workflow.id));
    complete_old(generation_result('obsolete design', workflow.source_path));
    await older;

    const [after_old] = await db
      .select({
        generation_status: projectWorkflows.generation_status,
        stale_at: projectWorkflows.stale_at,
      })
      .from(projectWorkflows)
      .where(eq(projectWorkflows.id, workflow.id));
    expect(after_old?.generation_status).toBe('GENERATING');
    expect(new Date(after_old!.stale_at!).getTime()).toBe(new Date(newer_stale_at).getTime());
    expect((await api.projects[project_id]!.status.get({ $headers: headers })).data?.status).toBe(
      'PENDING'
    );

    set_workflow_generation_mock(successful_generation);
    await workflows_service.regenerate(project_id, workflow.id);
    expect((await api.projects[project_id]!.status.get({ $headers: headers })).data?.status).toBe(
      'READY'
    );
  });

  test('fans shared edits out, preserves workflow identity, and removes a deleted source workflow', async () => {
    const { token, result } = await create_multi_project('workflow-lifecycle@cc-forge.test');
    const headers = bearer(token);
    const project_id = result.project.id;
    const original_ids = result.workflows.map(({ id }) => id).sort();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    set_workflow_generation_mock(async (input) => {
      await gate;
      return successful_generation(input);
    });

    const project_files = await api.projects[project_id]!.files.get({ $headers: headers });
    const shared_file = project_files.data!.find(
      ({ component_kind }) => component_kind === 'agent'
    )!;
    try {
      const patched = await api.projects[project_id]!.files[shared_file.id]!.patch(
        { content: '# changed shared agent\n' },
        { headers }
      );
      expect(patched.error).toBeNull();
      expect((await api.projects[project_id]!.status.get({ $headers: headers })).data?.status).toBe(
        'PENDING'
      );
      expect(
        (await api.projects[project_id]!.workflows.get({ $headers: headers })).data
          ?.map(({ id }) => id)
          .sort()
      ).toEqual(original_ids);
    } finally {
      release();
    }
    await workflows_queue.idle();

    const last_good = await api.projects[project_id]!.workflows[
      result.workflows[0]!.id
    ]!.design.get({ $headers: headers });
    expect(last_good.data?.id).toBe(result.workflows[0]!.id);
    set_workflow_generation_mock(async () => ({
      status: 'failed',
      error_message: 'regeneration failed',
    }));
    await api.projects[project_id]!.files[shared_file.id]!.patch(
      { content: '# changed again\n' },
      { headers }
    );
    await workflows_queue.idle();
    // A failed regeneration always resolves to FAILED, so the last-good design becomes unreachable
    // rather than being silently served as current.
    const after_failed_regeneration = await api.projects[project_id]!.workflows[
      result.workflows[0]!.id
    ]!.design.get({ $headers: headers });
    expect(after_failed_regeneration.error?.status as number).toBe(404);
    expect((await api.projects[project_id]!.status.get({ $headers: headers })).data?.status).toBe(
      'FAILED'
    );

    const source = result.workflows[0]!;
    await api.projects[project_id]!.files[source.source_file_id]!.patch(
      { content: '# source changed without a rename\n' },
      { headers }
    );
    await workflows_queue.idle();
    expect(
      (await api.projects[project_id]!.workflows[source.id]!.get({ $headers: headers })).data
        ?.source_file_id
    ).toBe(source.source_file_id);

    await api.projects[project_id]!.files[source.source_file_id]!.delete({ $headers: headers });
    await workflows_queue.idle();
    const remaining = await api.projects[project_id]!.workflows.get({ $headers: headers });
    expect(remaining.data).toHaveLength(1);
    expect(remaining.data?.some(({ id }) => id === source.id)).toBe(false);
  });

  test('enforces workflow source kind, same-project linkage, uniqueness, and reclassification in PostgreSQL', async () => {
    const first = await create_multi_project('workflow-db-a@cc-forge.test');
    const second = await create_multi_project('workflow-db-b@cc-forge.test');
    const first_project_id = first.result.project.id;
    const first_workflow = first.result.workflows[0]!;
    const first_files = await api.projects[first_project_id]!.files.get({
      $headers: bearer(first.token),
    });
    const ordinary_file = first_files.data!.find(
      ({ component_kind }) => component_kind === 'other'
    )!;

    await expect_database_error(
      Promise.resolve(
        db.insert(projectWorkflows).values({
          project_id: first_project_id,
          source_file_id: ordinary_file.id,
          generation_status: 'PENDING',
        })
      )
    );
    await expect_database_error(
      Promise.resolve(
        db.insert(projectWorkflows).values({
          project_id: second.result.project.id,
          source_file_id: first_workflow.source_file_id,
          generation_status: 'PENDING',
        })
      )
    );
    await expect_database_error(
      Promise.resolve(
        db.insert(projectWorkflows).values({
          project_id: first_project_id,
          source_file_id: first_workflow.source_file_id,
          generation_status: 'PENDING',
        })
      )
    );
    await expect_database_error(
      Promise.resolve(
        db
          .update(files)
          .set({ component_kind: 'other' })
          .where(
            and(eq(files.project_id, first_project_id), eq(files.id, first_workflow.source_file_id))
          )
      )
    );
    await expect_database_error(
      Promise.resolve(
        db
          .update(projectWorkflows)
          .set({ generation_status: 'READY', design: null })
          .where(eq(projectWorkflows.id, first_workflow.id))
      )
    );
  });

  test('workflow insertion wins the source reclassification race', async () => {
    const { project_id, source_file_id } = await create_unbacked_workflow_source(
      'workflow-race-insert-first@cc-forge.test'
    );
    const insert_client = postgres(config.database.url, { max: 1 });
    const update_client = postgres(config.database.url, { max: 1 });
    let insert_transaction_open = false;
    try {
      await insert_client`BEGIN`;
      insert_transaction_open = true;
      await insert_client`
        INSERT INTO project_workflows (project_id, source_file_id, generation_status)
        VALUES (${project_id}, ${source_file_id}, 'PENDING')
      `;

      let update_settled = false;
      const update_result = update_client`
        UPDATE files SET component_kind = 'other' WHERE id = ${source_file_id}
      `.then(
        () => {
          update_settled = true;
          return null;
        },
        (error) => {
          update_settled = true;
          return error;
        }
      );
      await Bun.sleep(50);
      expect(update_settled).toBe(false);
      await insert_client`COMMIT`;
      insert_transaction_open = false;
      expect(await update_result).toBeDefined();

      const [source] = await db
        .select({ component_kind: files.component_kind })
        .from(files)
        .where(eq(files.id, source_file_id));
      expect(source?.component_kind).toBe('workflow');
    } finally {
      if (insert_transaction_open) await insert_client`ROLLBACK`;
      await insert_client.end();
      await update_client.end();
    }
  });

  test('source reclassification wins the workflow insertion race', async () => {
    const { project_id, source_file_id } = await create_unbacked_workflow_source(
      'workflow-race-reclassify-first@cc-forge.test'
    );
    const update_client = postgres(config.database.url, { max: 1 });
    const insert_client = postgres(config.database.url, { max: 1 });
    let update_transaction_open = false;
    try {
      await update_client`BEGIN`;
      update_transaction_open = true;
      await update_client`
        UPDATE files SET component_kind = 'other' WHERE id = ${source_file_id}
      `;

      let insert_settled = false;
      const insert_result = insert_client`
        INSERT INTO project_workflows (project_id, source_file_id, generation_status)
        VALUES (${project_id}, ${source_file_id}, 'PENDING')
      `.then(
        () => {
          insert_settled = true;
          return null;
        },
        (error) => {
          insert_settled = true;
          return error;
        }
      );
      await Bun.sleep(50);
      expect(insert_settled).toBe(false);
      await update_client`COMMIT`;
      update_transaction_open = false;
      expect(await insert_result).toBeDefined();

      const rows = await db
        .select({ id: projectWorkflows.id })
        .from(projectWorkflows)
        .where(eq(projectWorkflows.source_file_id, source_file_id));
      expect(rows).toHaveLength(0);
    } finally {
      if (update_transaction_open) await update_client`ROLLBACK`;
      await update_client.end();
      await insert_client.end();
    }
  });

  test('does not expose top-level workflow status, stats, or design routes', async () => {
    const token = await authenticate('workflow-old-routes@cc-forge.test');
    const headers = bearer(token);
    const old_paths = [
      '/workflows/00000000-0000-4000-8000-000000000000/status',
      '/workflows/00000000-0000-4000-8000-000000000000/stats',
      '/workflows/00000000-0000-4000-8000-000000000000/design',
    ];
    for (const path of old_paths) {
      const response = await fetch(`${config.app.apiUrl}${path}`, { headers });
      expect(response.status).toBe(404);
    }
  });

  test('validates nested project and workflow identifiers and authentication', async () => {
    const { token, result } = await create_multi_project('workflow-validation@cc-forge.test');
    const headers = bearer(token);
    expect(
      (await api.projects['not-a-uuid']!.workflows.get({ $headers: headers })).error
        ?.status as number
    ).toBe(422);
    expect(
      (
        await api.projects[result.project.id]!.workflows['not-a-uuid']!.get({
          $headers: headers,
        })
      ).error?.status as number
    ).toBe(422);
    const unknown = '00000000-0000-4000-8000-000000000000';
    expect(
      (
        await api.projects[result.project.id]!.workflows[unknown]!.get({
          $headers: headers,
        })
      ).error?.status as number
    ).toBe(404);
    expect(
      (await api.projects[result.project.id]!.workflows[result.workflows[0]!.id]!.get()).error
        ?.status as number
    ).toBe(401);
  });
});
