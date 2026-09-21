import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { and, asc, eq, sql } from 'drizzle-orm';

import { db } from '@api/db/client';
import { deploymentEvents, deployments } from '@api/db/schema';
import { config } from '@core/env';

import {
  clear_deploy_agent_caller,
  set_deploy_agent_caller,
  set_deploy_agent_poll,
} from '../modules/deploy/deploy.agent.testkit';
import { deployments_repo } from '../modules/deploy/deploy.repo';
import { sweep_stale_deployments } from '../modules/deploy/deploy.service';
import {
  clear_mock_deploy_script,
  release_hold,
  set_mock_deploy_script,
} from '../modules/deploy/deploy.worker.mock.testkit';
import {
  clear_workflow_generation_mock,
  set_workflow_generation_mock,
} from '../modules/workflows/workflows.generation.testkit';
import { workflows_queue } from '../modules/workflows/workflows.queue';
import { DeployProviderId, DeploySseFrameSchema } from '../sdk/deploy';
import { api, setupE2ETests } from './e2e.setup';
import {
  add_company_member,
  authenticate,
  bearer,
  create_deploy_setup,
} from './project-test.utils';
import type { DeploymentStatus, DeploySseFrame } from '../sdk/deploy';

setupE2ETests();

beforeEach(() => {
  set_workflow_generation_mock(async () => ({ status: 'failed', error_message: 'deploy test' }));
});

afterEach(async () => {
  release_hold();
  clear_mock_deploy_script();
  clear_deploy_agent_caller();
  await workflows_queue.idle();
  clear_workflow_generation_mock();
});

async function provision(email: string) {
  const token = await authenticate(email);
  const setup = await create_deploy_setup(token);
  const project = await api.projects.post(
    {
      name: 'Deploy Project',
      files: [
        { path: 'workflow.py', content: 'def run(): pass\n' },
        { path: 'agents/router.agent.py', content: '# agent\n' },
        { path: 'tools/search.tool.py', content: '# tool\n' },
        { path: 'README.md', content: '# other\n' },
      ],
    },
    { headers: bearer(token) }
  );
  expect(project.error).toBeNull();
  return { token, setup, project_id: project.data!.project.id };
}

function parse_sse(body: string): DeploySseFrame[] {
  return body
    .split('\n\n')
    .map((f) => f.trim())
    .filter(Boolean)
    .map((frame) => {
      const lines = frame.split('\n');
      const id = lines
        .find((l) => l.startsWith('id:'))
        ?.slice(3)
        .trim();
      const event =
        lines
          .find((l) => l.startsWith('event:'))
          ?.slice(6)
          .trim() ?? '';
      const data =
        lines
          .find((l) => l.startsWith('data:'))
          ?.slice(5)
          .trim() ?? '{}';
      return DeploySseFrameSchema.parse({ id, event, data: JSON.parse(data) });
    });
}

async function enqueue(project_id: string, token: string) {
  const response = await api.projects[project_id]!.deploy.post({}, { headers: bearer(token) });
  expect(response.error).toBeNull();
  expect(response.status).toBe(202);
  return response.data!;
}

async function read_stream(
  project_id: string,
  deploy_id: string,
  token: string,
  last_event_id?: string
): Promise<DeploySseFrame[]> {
  const headers: Record<string, string> = { ...bearer(token) };
  if (last_event_id !== undefined) headers['last-event-id'] = last_event_id;
  const response = await fetch(
    `${config.app.apiUrl}/projects/${project_id}/deploy/${deploy_id}/stream`,
    { headers }
  );
  expect(response.status).toBe(200);
  return parse_sse(await response.text());
}

async function wait_for_condition(
  ready: () => Promise<boolean>,
  what: string,
  attempts = 400
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await ready()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function wait_for_status(deploy_id: string, status: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const [row] = await db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.id, deploy_id));
    if (row?.status === status) return;
    await Bun.sleep(5);
  }
  throw new Error(`deployment ${deploy_id} never reached status ${status}`);
}

describe('project deploy', () => {
  test('returns project-scoped config and accepts an all-file deployment target', async () => {
    const { token, setup, project_id } = await provision('deploy-project@cc-forge.test');
    const headers = bearer(token);
    const config_response = await api.projects[project_id]!.deploy.config.get({
      $headers: headers,
    });

    expect(config_response.error).toBeNull();
    expect(config_response.data).toMatchObject({
      id: setup.id,
      project_id,
      project_name: 'Deploy Project',
      provider: DeployProviderId.AWS,
    });
    expect(config_response.data!.providers).toEqual([
      { id: DeployProviderId.AWS, name: 'AWS', enabled: true },
      { id: DeployProviderId.GCP, name: 'GCP', enabled: false },
    ]);
    expect(Object.hasOwn(config_response.data!, 'fields')).toBe(false);
    expect(config_response.data!.has_previous_deploy).toBe(false);

    const accepted = await api.projects[project_id]!.deploy.post({}, { headers });
    expect(accepted.error).toBeNull();
    expect(accepted.status).toBe(202);
    expect(accepted.data).toMatchObject({ project_id, status: 'accepted', file_count: 4 });
    expect(accepted.data!.deploy_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  test('config flags has_previous_deploy once a deployment has succeeded', async () => {
    const { token, project_id } = await provision('deploy-baseline@cc-forge.test');
    const headers = bearer(token);

    const accepted = await api.projects[project_id]!.deploy.post({}, { headers });
    await wait_for_status(accepted.data!.deploy_id, 'success');

    const config_response = await api.projects[project_id]!.deploy.config.get({
      $headers: headers,
    });
    expect(config_response.data!.has_previous_deploy).toBe(true);
  });

  test('allows config and submission from a teammate and from another company', async () => {
    const owner = await provision('deploy-owner@cc-forge.test');
    const member = await add_company_member(owner.token, 'deploy-member@cc-forge.test');
    expect(
      (
        await api.projects[owner.project_id]!.deploy.config.get({
          $headers: bearer(member),
        })
      ).data?.project_id
    ).toBe(owner.project_id);
    expect(
      (await api.projects[owner.project_id]!.deploy.post({}, { headers: bearer(member) })).data
        ?.status
    ).toBe('accepted');

    // The deploy setup comes from the project, so a caller whose own company has none still deploys.
    const other_company = await authenticate('deploy-outsider@cc-forge.test');
    expect(
      (
        await api.projects[owner.project_id]!.deploy.config.get({
          $headers: bearer(other_company),
        })
      ).data?.project_id
    ).toBe(owner.project_id);

    const second = await provision('deploy-owner-second@cc-forge.test');
    expect(
      (await api.projects[second.project_id]!.deploy.post({}, { headers: bearer(other_company) }))
        .data?.status
    ).toBe('accepted');
  });

  test('validates the project id, payload, setup, and authentication', async () => {
    const { token, project_id } = await provision('deploy-validation@cc-forge.test');
    const headers = bearer(token);
    expect(
      (
        await api.projects[project_id]!.deploy.post({ region: 'us-west-2' } as never, {
          headers,
        })
      ).error?.status as number
    ).toBe(422);
    expect(
      (
        await api.projects['not-a-uuid']!.deploy.config.get({
          $headers: headers,
        })
      ).error?.status as number
    ).toBe(422);
    expect((await api.projects[project_id]!.deploy.config.get()).error?.status as number).toBe(401);

    const without_setup = await authenticate('deploy-no-setup@cc-forge.test');
    const project = await api.projects.post(
      { name: 'No Setup', files: [{ path: 'workflow.py', content: 'pass\n' }] },
      { headers: bearer(without_setup) }
    );
    expect(
      (
        await api.projects[project.data!.project.id]!.deploy.config.get({
          $headers: bearer(without_setup),
        })
      ).error?.status as number
    ).toBe(404);
  });

  test('does not expose legacy top-level deploy routes', async () => {
    const { token, project_id } = await provision('deploy-old-route@cc-forge.test');
    const path = '/deploy/00000000-0000-4000-8000-000000000000';
    expect((await fetch(`${config.app.apiUrl}${path}`, { headers: bearer(token) })).status).toBe(
      404
    );
    expect(
      (
        await fetch(`${config.app.apiUrl}${path}`, {
          method: 'POST',
          headers: { ...bearer(token), 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
      ).status
    ).toBe(404);
    // The latest-by-project stream is gone; `stream` now reads as a deploy_id on the by-id route and
    // fails uuid validation.
    expect(
      (
        await fetch(`${config.app.apiUrl}/projects/${project_id}/deploy/stream`, {
          headers: bearer(token),
        })
      ).status
    ).toBe(422);
  });
});

describe('project deploy queue', () => {
  test('enqueue returns a deploy_id and creates the pending row', async () => {
    const { token, project_id } = await provision('deploy-enqueue@cc-forge.test');
    const accepted = await enqueue(project_id, token);
    expect(accepted).toMatchObject({ project_id, status: 'accepted', file_count: 4 });

    const [row] = await db.select().from(deployments).where(eq(deployments.id, accepted.deploy_id));
    expect(row).toBeDefined();
    expect(row!.project_id).toBe(project_id);

    // The enqueue transaction always writes the opening event as seq 1; unlike the row's live
    // status (which the mock worker races forward), this is immutable and deterministic.
    const [opening] = await db
      .select()
      .from(deploymentEvents)
      .where(eq(deploymentEvents.deployment_id, accepted.deploy_id))
      .orderBy(asc(deploymentEvents.seq))
      .limit(1);
    expect(opening).toMatchObject({ seq: 1, status: 'pending' });
  });

  test('streams pending then every phase in order and finishes succeeded', async () => {
    const { token, project_id } = await provision('deploy-happy@cc-forge.test');
    const accepted = await enqueue(project_id, token);
    const frames = await read_stream(project_id, accepted.deploy_id, token);

    expect(
      frames.map((frame) => (frame.event === 'phase' ? frame.data.phase : frame.event))
    ).toEqual([
      'pending',
      'receiving_files',
      'processing_files',
      'provisioning_resources',
      'launching_resources',
      'succeeded',
    ]);
    expect(frames.map((frame) => frame.id)).toEqual(
      [1, 2, 3, 4, 5, 6].map((seq) => `${accepted.deploy_id}:${seq}`)
    );
    const last = frames.at(-1)!;
    expect(last.event).toBe('succeeded');
    expect(last.data).toEqual({ type: 'succeeded', address: '203.0.113.42' });
  });

  test('rejects an enqueue when the project has no files', async () => {
    const token = await authenticate('deploy-empty@cc-forge.test');
    await create_deploy_setup(token);
    const project = await api.projects.post(
      { name: 'Empty', files: [{ path: 'workflow.py', content: 'pass\n' }] },
      { headers: bearer(token) }
    );
    const project_id = project.data!.project.id;
    await workflows_queue.idle();
    await api.projects[project_id]!.files[project.data!.workflows[0]!.source_file_id]!.delete({
      $headers: bearer(token),
    });

    const response = await api.projects[project_id]!.deploy.post({}, { headers: bearer(token) });
    expect(response.error?.status as number).toBe(400);
    expect(response.error?.value).toMatchObject({ error: 'deploy.no_files' });
  });

  test('rejects a second enqueue while one is already running, then completes the first', async () => {
    const { token, project_id } = await provision('deploy-conflict@cc-forge.test');
    set_mock_deploy_script({ hold_at: 'processing_files' });
    const accepted = await enqueue(project_id, token);
    await wait_for_status(accepted.deploy_id, 'processing_files');

    const second = await api.projects[project_id]!.deploy.post({}, { headers: bearer(token) });
    expect(second.error?.status as number).toBe(409);
    expect(second.error?.value).toMatchObject({ error: 'deploy.already_running' });

    release_hold();
    const frames = await read_stream(project_id, accepted.deploy_id, token);
    expect(frames.at(-1)!.event).toBe('succeeded');
  });

  test('streams a failed terminal event when the worker fails a phase', async () => {
    const { token, project_id } = await provision('deploy-failure@cc-forge.test');
    set_mock_deploy_script({ fail_at: 'provisioning_resources', fail_message: 'ventis exploded' });
    const accepted = await enqueue(project_id, token);
    const frames = await read_stream(project_id, accepted.deploy_id, token);

    // The worker fails AT provisioning_resources (before advancing to it), so that phase must never
    // be emitted. Read the real phase value, not the SSE event name (which is only phase/…/failed).
    expect(
      frames.map((frame) => (frame.event === 'phase' ? frame.data.phase : frame.event))
    ).not.toContain('provisioning_resources');
    const last = frames.at(-1)!;
    expect(last.event).toBe('failed');
    expect(last.data).toEqual({ type: 'failed', message: 'ventis exploded' });
  });

  test('replays the full history of a completed deployment then closes', async () => {
    const { token, project_id } = await provision('deploy-replay@cc-forge.test');
    const accepted = await enqueue(project_id, token);
    await wait_for_status(accepted.deploy_id, 'success');

    const frames = await read_stream(project_id, accepted.deploy_id, token);
    expect(frames.map((frame) => frame.id)).toEqual(
      [1, 2, 3, 4, 5, 6].map((seq) => `${accepted.deploy_id}:${seq}`)
    );
    expect(frames.at(-1)!.event).toBe('succeeded');
  });

  test('honors Last-Event-ID by replaying only newer events', async () => {
    const { token, project_id } = await provision('deploy-resume@cc-forge.test');
    const accepted = await enqueue(project_id, token);
    await wait_for_status(accepted.deploy_id, 'success');

    const frames = await read_stream(
      project_id,
      accepted.deploy_id,
      token,
      `${accepted.deploy_id}:3`
    );
    expect(frames.map((frame) => frame.id)).toEqual(
      [4, 5, 6].map((seq) => `${accepted.deploy_id}:${seq}`)
    );
    expect(frames[0]).toMatchObject({
      event: 'phase',
      data: { type: 'phase', phase: 'provisioning_resources' },
    });
    expect(frames.at(-1)!.event).toBe('succeeded');
  });

  test("does not apply another deployment's Last-Event-ID", async () => {
    const { token, project_id } = await provision('deploy-resume-other@cc-forge.test');
    const first = await enqueue(project_id, token);
    await wait_for_status(first.deploy_id, 'success');

    const second = await enqueue(project_id, token);
    await wait_for_status(second.deploy_id, 'success');

    const frames = await read_stream(project_id, second.deploy_id, token, `${first.deploy_id}:6`);
    expect(frames.map((frame) => frame.id)).toEqual(
      [1, 2, 3, 4, 5, 6].map((seq) => `${second.deploy_id}:${seq}`)
    );
    expect(frames.at(-1)!.event).toBe('succeeded');
  });

  test('closes immediately when resuming at/after the terminal event', async () => {
    const { token, project_id } = await provision('deploy-resume-end@cc-forge.test');
    const accepted = await enqueue(project_id, token);
    await wait_for_status(accepted.deploy_id, 'success');

    // Last-Event-ID past the final seq (6) replays nothing; the stream must close, not hang.
    const frames = await read_stream(
      project_id,
      accepted.deploy_id,
      token,
      `${accepted.deploy_id}:6`
    );
    expect(frames).toEqual([]);
  });

  test('requires auth and opens the stream to any signed-in user', async () => {
    const { token, project_id } = await provision('deploy-stream-auth@cc-forge.test');
    const accepted = await enqueue(project_id, token);
    const stream_url = `${config.app.apiUrl}/projects/${project_id}/deploy/${accepted.deploy_id}/stream`;
    const anonymous = await fetch(stream_url);
    expect(anonymous.status).toBe(401);

    const other_company = await authenticate('deploy-stream-outsider@cc-forge.test');
    const allowed = await fetch(stream_url, { headers: bearer(other_company) });
    expect(allowed.status).toBe(200);
    await allowed.body?.cancel();
  });

  test('rejects a deployment id that belongs to another owned project', async () => {
    const { token, project_id } = await provision('deploy-stream-relation@cc-forge.test');
    const accepted = await enqueue(project_id, token);
    const other = await api.projects.post(
      { name: 'Other Deploy Project', files: [{ path: 'workflow.py', content: 'pass\n' }] },
      { headers: bearer(token) }
    );
    expect(other.error).toBeNull();

    const mismatch = await fetch(
      `${config.app.apiUrl}/projects/${other.data!.project.id}/deploy/${accepted.deploy_id}/stream`,
      { headers: bearer(token) }
    );
    expect(mismatch.status).toBe(404);
  });

  test('streams failed details larger than the PostgreSQL NOTIFY payload limit', async () => {
    const { token, project_id } = await provision('deploy-large-detail@cc-forge.test');
    set_mock_deploy_script({ hold_at: 'processing_files' });
    const accepted = await enqueue(project_id, token);
    await wait_for_status(accepted.deploy_id, 'processing_files');

    const message = 'x'.repeat(9_000);
    const failed = await deployments_repo.mark_failed_with_event(accepted.deploy_id, message);
    expect(failed?.status).toBe('failed');

    const frames = await read_stream(project_id, accepted.deploy_id, token);
    expect(frames.at(-1)).toMatchObject({
      event: 'failed',
      data: { type: 'failed', message },
    });
  });

  test('reclaims a deployment whose worker went silent past the lease', async () => {
    const { token, project_id } = await provision('deploy-reclaim@cc-forge.test');
    set_mock_deploy_script({ hold_at: 'processing_files' });
    const accepted = await enqueue(project_id, token);
    await wait_for_status(accepted.deploy_id, 'processing_files');

    await db
      .update(deployments)
      .set({ heartbeat_at: sql`now() - interval '10 minutes'` })
      .where(eq(deployments.id, accepted.deploy_id));

    const reclaimed = await sweep_stale_deployments();
    expect(reclaimed).toBeGreaterThanOrEqual(1);

    const [row] = await db
      .select({ status: deployments.status, error: deployments.error })
      .from(deployments)
      .where(eq(deployments.id, accepted.deploy_id));
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('worker lost');

    const frames = await read_stream(project_id, accepted.deploy_id, token);
    const last = frames.at(-1)!;
    expect(last.event).toBe('failed');
    expect(last.data).toEqual({ type: 'failed', message: 'worker lost' });
  });
});

describe('project deploy test proxy', () => {
  const PROBE = { query: 'ping the deployed agent' };

  async function deploy_to_success(email: string) {
    const { token, project_id } = await provision(email);
    const accepted = await enqueue(project_id, token);
    await wait_for_status(accepted.deploy_id, 'success');
    return { token, project_id, deploy_id: accepted.deploy_id };
  }

  // Answers the agent's two-leg async contract: POST /main accepts the job and hands back a
  // request_id; GET /status/<id> reports it done with the result. Captures the submitted POST body.
  function stub_async_agent(result: unknown): { submit_url?: string; submit_body?: string } {
    const captured: { submit_url?: string; submit_body?: string } = {};
    set_deploy_agent_caller(async (url, init) => {
      if (url.includes('/status/')) {
        return {
          status: 200,
          text: JSON.stringify({ request_id: 'req-test', status: 'done', result }),
        };
      }
      captured.submit_url = url;
      captured.submit_body = init?.body;
      return { status: 202, text: JSON.stringify({ request_id: 'req-test' }) };
    });
    return captured;
  }

  test('forwards the query as the agent payload and returns the unwrapped result', async () => {
    const { token, project_id, deploy_id } = await deploy_to_success(
      'deploy-test-ok@cc-forge.test'
    );
    const query = 'Analyze 40% Apple, 35% Microsoft and 25% Nvidia over the last 6 months';
    const result = { response: { answer: 'reset it here' } };
    const captured = stub_async_agent(result);

    const response = await api.projects[project_id]!.deploy[deploy_id]!.test.post(
      { query },
      { headers: bearer(token) }
    );
    expect(response.error).toBeNull();
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ ok: true, status: 200, body: result });

    expect(captured.submit_url).toBe('http://203.0.113.42:8080/main');
    expect(JSON.parse(captured.submit_body!)).toEqual({ query });
  });

  // The agent has nothing to answer without a prompt, so anything but a non-empty `query` string
  // stops at the schema — the dashboard keeps its Test button disabled for the same reason.
  test('rejects a body that is not a non-empty query with 422', async () => {
    const { token, project_id, deploy_id } = await deploy_to_success(
      'deploy-test-invalid@cc-forge.test'
    );
    const captured = stub_async_agent({ response: { answer: 'ok' } });

    for (const body of [[1, 2, 3], {}, { query: '   ' }, { query: 7 }, { query: 'hi', extra: 1 }]) {
      const response = await fetch(
        `${config.app.apiUrl}/projects/${project_id}/deploy/${deploy_id}/test`,
        {
          method: 'POST',
          headers: { ...bearer(token), 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
      expect(response.status).toBe(422);
    }
    expect(captured.submit_body).toBeUndefined();
  });

  test('trims the query before it reaches the agent', async () => {
    const { token, project_id, deploy_id } = await deploy_to_success(
      'deploy-test-trim@cc-forge.test'
    );
    const captured = stub_async_agent({ response: { answer: 'ok' } });

    const response = await api.projects[project_id]!.deploy[deploy_id]!.test.post(
      { query: '  rebalance my portfolio \n' },
      { headers: bearer(token) }
    );
    expect(response.error).toBeNull();
    expect(JSON.parse(captured.submit_body!)).toEqual({ query: 'rebalance my portfolio' });
  });

  test('polls the status endpoint until the job reports done', async () => {
    const { token, project_id, deploy_id } = await deploy_to_success(
      'deploy-test-poll@cc-forge.test'
    );
    const result = { response: { answer: 'done polling' } };
    let status_calls = 0;
    set_deploy_agent_caller(async (url) => {
      if (url.includes('/status/')) {
        status_calls += 1;
        return status_calls < 3
          ? { status: 200, text: JSON.stringify({ request_id: 'req-test', status: 'running' }) }
          : {
              status: 200,
              text: JSON.stringify({ request_id: 'req-test', status: 'done', result }),
            };
      }
      return { status: 202, text: JSON.stringify({ request_id: 'req-test' }) };
    });
    set_deploy_agent_poll({ interval_ms: 1, timeout_ms: 1000 });

    const response = await api.projects[project_id]!.deploy[deploy_id]!.test.post(PROBE, {
      headers: bearer(token),
    });
    expect(response.error).toBeNull();
    expect(response.data).toEqual({ ok: true, status: 200, body: result });
    expect(status_calls).toBeGreaterThanOrEqual(3);
  });

  test('passes a non-2xx submit response through raw with ok:false', async () => {
    const { token, project_id, deploy_id } = await deploy_to_success(
      'deploy-test-5xx@cc-forge.test'
    );
    set_deploy_agent_caller(async () => ({ status: 503, text: 'service unavailable' }));

    const response = await api.projects[project_id]!.deploy[deploy_id]!.test.post(PROBE, {
      headers: bearer(token),
    });
    expect(response.error).toBeNull();
    expect(response.data).toEqual({ ok: false, status: 503, body: 'service unavailable' });
  });

  test('passes a status 404 through raw with ok:false', async () => {
    const { token, project_id, deploy_id } = await deploy_to_success(
      'deploy-test-status404@cc-forge.test'
    );
    set_deploy_agent_caller(async (url) =>
      url.includes('/status/')
        ? { status: 404, text: JSON.stringify({ error: 'Request not found' }) }
        : { status: 202, text: JSON.stringify({ request_id: 'req-test' }) }
    );

    const response = await api.projects[project_id]!.deploy[deploy_id]!.test.post(PROBE, {
      headers: bearer(token),
    });
    expect(response.error).toBeNull();
    expect(response.data).toEqual({ ok: false, status: 404, body: { error: 'Request not found' } });
  });

  test('returns 502 when the job never finishes before the poll deadline', async () => {
    const { token, project_id, deploy_id } = await deploy_to_success(
      'deploy-test-timeout@cc-forge.test'
    );
    set_deploy_agent_caller(async (url) =>
      url.includes('/status/')
        ? { status: 200, text: JSON.stringify({ request_id: 'req-test', status: 'running' }) }
        : { status: 202, text: JSON.stringify({ request_id: 'req-test' }) }
    );
    set_deploy_agent_poll({ interval_ms: 1, timeout_ms: 5 });

    const response = await api.projects[project_id]!.deploy[deploy_id]!.test.post(PROBE, {
      headers: bearer(token),
    });
    expect(response.error?.status as number).toBe(502);
    expect(response.error?.value).toMatchObject({ error: 'deploy.test_timeout' });
  });

  test('returns 502 immediately when the deployed workflow reports status error', async () => {
    const { token, project_id, deploy_id } = await deploy_to_success(
      'deploy-test-workflow-error@cc-forge.test'
    );
    set_deploy_agent_caller(async (url) =>
      url.includes('/status/')
        ? {
            status: 200,
            text: JSON.stringify({ request_id: 'req-test', status: 'error', error: 'boom' }),
          }
        : { status: 202, text: JSON.stringify({ request_id: 'req-test' }) }
    );

    const response = await api.projects[project_id]!.deploy[deploy_id]!.test.post(PROBE, {
      headers: bearer(token),
    });
    expect(response.error?.status as number).toBe(502);
    expect(response.error?.value).toMatchObject({ error: 'deploy.test_failed' });
  });

  test('returns 404 for a deploy_id that does not exist', async () => {
    const { token, project_id } = await provision('deploy-test-missing@cc-forge.test');
    const response = await api.projects[project_id]!.deploy[
      '00000000-0000-4000-8000-000000000000'
    ]!.test.post(PROBE, { headers: bearer(token) });
    expect(response.error?.status as number).toBe(404);
    expect(response.error?.value).toMatchObject({ error: 'deploy.not_found' });
  });

  test('returns 404 for a deploy_id that belongs to another project', async () => {
    const { token, deploy_id } = await deploy_to_success('deploy-test-scope@cc-forge.test');
    const other = await api.projects.post(
      { name: 'Other', files: [{ path: 'workflow.py', content: 'pass\n' }] },
      { headers: bearer(token) }
    );
    const other_project_id = other.data!.project.id;

    const response = await api.projects[other_project_id]!.deploy[deploy_id]!.test.post(PROBE, {
      headers: bearer(token),
    });
    expect(response.error?.status as number).toBe(404);
    expect(response.error?.value).toMatchObject({ error: 'deploy.not_found' });
  });

  test('returns 409 when the deployment has not yet produced a live endpoint', async () => {
    const { token, project_id } = await provision('deploy-test-pending@cc-forge.test');
    set_mock_deploy_script({ hold_at: 'processing_files' });
    const accepted = await enqueue(project_id, token);
    await wait_for_status(accepted.deploy_id, 'processing_files');

    const response = await api.projects[project_id]!.deploy[accepted.deploy_id]!.test.post(PROBE, {
      headers: bearer(token),
    });
    expect(response.error?.status as number).toBe(409);
    expect(response.error?.value).toMatchObject({ error: 'deploy.no_address' });
  });

  test('returns 502 when the deployed endpoint is unreachable', async () => {
    const { token, project_id, deploy_id } = await deploy_to_success(
      'deploy-test-down@cc-forge.test'
    );
    set_deploy_agent_caller(async () => {
      throw new Error('connect ETIMEDOUT');
    });

    const response = await api.projects[project_id]!.deploy[deploy_id]!.test.post(PROBE, {
      headers: bearer(token),
    });
    expect(response.error?.status as number).toBe(502);
    expect(response.error?.value).toMatchObject({ error: 'deploy.test_unreachable' });
  });

  test('requires auth and opens the endpoint to any signed-in user', async () => {
    const { project_id, deploy_id } = await deploy_to_success('deploy-test-owner@cc-forge.test');
    expect(
      (await api.projects[project_id]!.deploy[deploy_id]!.test.post(PROBE)).error?.status as number
    ).toBe(401);

    stub_async_agent({ response: { answer: 'ok' } });
    const other_company = await authenticate('deploy-test-outsider@cc-forge.test');
    const response = await api.projects[project_id]!.deploy[deploy_id]!.test.post(PROBE, {
      headers: bearer(other_company),
    });
    expect(response.error).toBeNull();
    expect(response.data).toMatchObject({ ok: true, status: 200 });
  });
});

describe('project deploy info', () => {
  test('returns the deployment record for an owned deploy', async () => {
    const { token, project_id } = await provision('deploy-info-ok@cc-forge.test');
    const accepted = await enqueue(project_id, token);
    await wait_for_status(accepted.deploy_id, 'success');

    const response = await api.projects[project_id]!.deploy[accepted.deploy_id]!.get({
      $headers: bearer(token),
    });
    expect(response.error).toBeNull();
    expect(response.status).toBe(200);
    expect(response.data).toMatchObject({
      id: accepted.deploy_id,
      project_id,
      status: 'success',
      address: '203.0.113.42',
      error: null,
    });
    expect(typeof response.data?.created_at).toBe('string');
    expect(typeof response.data?.updated_at).toBe('string');
  });

  test('reflects an in-flight status up front, without a stream', async () => {
    const { token, project_id } = await provision('deploy-info-live@cc-forge.test');
    set_mock_deploy_script({ hold_at: 'processing_files' });
    const accepted = await enqueue(project_id, token);
    await wait_for_status(accepted.deploy_id, 'processing_files');

    const response = await api.projects[project_id]!.deploy[accepted.deploy_id]!.get({
      $headers: bearer(token),
    });
    expect(response.data?.status).toBe('processing_files');
    expect(response.data?.address).toBeNull();
  });

  test('returns 404 for a deploy_id that does not exist', async () => {
    const { token, project_id } = await provision('deploy-info-missing@cc-forge.test');
    const response = await api.projects[project_id]!.deploy[
      '00000000-0000-4000-8000-000000000000'
    ]!.get({ $headers: bearer(token) });
    expect(response.error?.status as number).toBe(404);
    expect(response.error?.value).toMatchObject({ error: 'deploy.not_found' });
  });

  test('returns 404 for a deploy_id that belongs to another project', async () => {
    const { token, project_id } = await provision('deploy-info-scope@cc-forge.test');
    const accepted = await enqueue(project_id, token);
    await wait_for_status(accepted.deploy_id, 'success');
    const other = await api.projects.post(
      { name: 'Other', files: [{ path: 'workflow.py', content: 'pass\n' }] },
      { headers: bearer(token) }
    );
    const other_project_id = other.data!.project.id;

    const response = await api.projects[other_project_id]!.deploy[accepted.deploy_id]!.get({
      $headers: bearer(token),
    });
    expect(response.error?.status as number).toBe(404);
    expect(response.error?.value).toMatchObject({ error: 'deploy.not_found' });
  });

  test('requires auth and shows the deploy to any signed-in user', async () => {
    const { token, project_id } = await provision('deploy-info-owner@cc-forge.test');
    const accepted = await enqueue(project_id, token);
    await wait_for_status(accepted.deploy_id, 'success');

    expect(
      (await api.projects[project_id]!.deploy[accepted.deploy_id]!.get()).error?.status as number
    ).toBe(401);

    const other_company = await authenticate('deploy-info-outsider@cc-forge.test');
    expect(
      (
        await api.projects[project_id]!.deploy[accepted.deploy_id]!.get({
          $headers: bearer(other_company),
        })
      ).data?.id
    ).toBe(accepted.deploy_id);
  });
});

describe('project deploy summary', () => {
  type Provisioned = Awaited<ReturnType<typeof provision>>;

  async function seed_deployment_at(
    { project_id, setup }: Provisioned,
    values: {
      status: DeploymentStatus;
      created_at: string;
      address?: string | null;
      error?: string | null;
    }
  ): Promise<string> {
    const [row] = await db
      .insert(deployments)
      .values({
        project_id,
        company_id: setup.company_id,
        created_by: setup.created_by,
        deploy_setup_id: setup.id,
        status: values.status,
        address: values.address ?? null,
        error: values.error ?? null,
        created_at: values.created_at,
        updated_at: values.created_at,
      })
      .returning({ id: deployments.id });
    return row!.id;
  }

  test('returns both null when the project has never deployed', async () => {
    const { token, project_id } = await provision('deploy-summary-none@cc-forge.test');
    const response = await api.projects[project_id]!.deploy.summary.get({
      $headers: bearer(token),
    });
    expect(response.error).toBeNull();
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ latest: null, active: null });
  });

  test('returns the latest terminal deploy and the in-flight deploy', async () => {
    const target = await provision('deploy-summary-both@cc-forge.test');
    await seed_deployment_at(target, {
      status: 'success',
      address: '203.0.113.10',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const failed_id = await seed_deployment_at(target, {
      status: 'failed',
      error: 'boom',
      created_at: '2026-02-01T00:00:00.000Z',
    });
    const active_id = await seed_deployment_at(target, {
      status: 'provisioning_resources',
      created_at: '2026-03-01T00:00:00.000Z',
    });

    const response = await api.projects[target.project_id]!.deploy.summary.get({
      $headers: bearer(target.token),
    });
    expect(response.error).toBeNull();
    expect(response.data?.latest).toMatchObject({ id: failed_id, status: 'failed' });
    expect(response.data?.active).toMatchObject({
      id: active_id,
      status: 'provisioning_resources',
    });
  });

  test('leaves active null when every deploy is terminal', async () => {
    const target = await provision('deploy-summary-terminal@cc-forge.test');
    await seed_deployment_at(target, { status: 'failed', created_at: '2026-01-01T00:00:00.000Z' });
    const success_id = await seed_deployment_at(target, {
      status: 'success',
      created_at: '2026-02-01T00:00:00.000Z',
    });

    const response = await api.projects[target.project_id]!.deploy.summary.get({
      $headers: bearer(target.token),
    });
    expect(response.data?.latest).toMatchObject({ id: success_id, status: 'success' });
    expect(response.data?.active).toBeNull();
  });

  test('returns the summary to a user from another company', async () => {
    const owner = await provision('deploy-summary-owner@cc-forge.test');
    const deploy_id = await seed_deployment_at(owner, {
      status: 'success',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const other_company = await authenticate('deploy-summary-outsider@cc-forge.test');
    const response = await api.projects[owner.project_id]!.deploy.summary.get({
      $headers: bearer(other_company),
    });
    expect(response.error).toBeNull();
    expect(response.data?.latest).toMatchObject({ id: deploy_id, status: 'success' });
  });

  test('requires authentication and validates the project id', async () => {
    const { token, project_id } = await provision('deploy-summary-validation@cc-forge.test');
    expect((await api.projects[project_id]!.deploy.summary.get()).error?.status as number).toBe(
      401
    );
    expect(
      (await api.projects['not-a-uuid']!.deploy.summary.get({ $headers: bearer(token) })).error
        ?.status as number
    ).toBe(422);
  });
});

describe('deployment overview', () => {
  type Provisioned = Awaited<ReturnType<typeof provision>>;

  // Insert a deployment row directly so the test owns the status and activity timestamp, instead of
  // racing the mock worker. The partial unique index permits at most one non-terminal row per project.
  async function seed_deployment(
    { project_id, setup }: Provisioned,
    values: {
      status: DeploymentStatus;
      updated_at?: string;
      address?: string | null;
      error?: string | null;
    }
  ): Promise<string> {
    const [row] = await db
      .insert(deployments)
      .values({
        project_id,
        company_id: setup.company_id,
        created_by: setup.created_by,
        deploy_setup_id: setup.id,
        status: values.status,
        address: values.address ?? null,
        error: values.error ?? null,
        ...(values.updated_at ? { updated_at: values.updated_at } : {}),
      })
      .returning({ id: deployments.id });
    return row!.id;
  }

  test('lists deployments joined to their projects, most-recent activity first', async () => {
    const target = await provision('overview-happy@cc-forge.test');
    const success_id = await seed_deployment(target, {
      status: 'success',
      address: '203.0.113.10',
      updated_at: '2099-01-01T00:00:00.000Z',
    });
    const failed_id = await seed_deployment(target, {
      status: 'failed',
      error: 'boom',
      updated_at: '2099-02-01T00:00:00.000Z',
    });
    const pending_id = await seed_deployment(target, {
      status: 'pending',
      updated_at: '2099-03-01T00:00:00.000Z',
    });

    const response = await api.projects.deployments.get({
      $query: { state: 'all', limit: 10 },
      $headers: bearer(target.token),
    });
    expect(response.error).toBeNull();
    expect(response.status).toBe(200);

    // The seeded rows carry the newest activity in the install, so they lead the list.
    const items = response.data!.slice(0, 3);
    expect(items.map((item) => item.id)).toEqual([pending_id, failed_id, success_id]);
    for (const item of items) {
      expect(item.project_id).toBe(target.project_id);
      expect(item.project_name).toBe('Deploy Project');
      expect(typeof item.created_at).toBe('string');
      expect(typeof item.updated_at).toBe('string');
    }
    expect(items.find((item) => item.id === success_id)).toMatchObject({
      status: 'success',
      address: '203.0.113.10',
      error: null,
    });
    expect(items.find((item) => item.id === failed_id)).toMatchObject({
      status: 'failed',
      address: null,
      error: 'boom',
    });
  });

  test('filters by state: active excludes terminal rows, success/failed match exactly, all returns everything', async () => {
    const target = await provision('overview-filter@cc-forge.test');
    const success_id = await seed_deployment(target, {
      status: 'success',
      updated_at: '2099-01-01T00:00:00.000Z',
    });
    const failed_id = await seed_deployment(target, {
      status: 'failed',
      updated_at: '2099-02-01T00:00:00.000Z',
    });
    const pending_id = await seed_deployment(target, {
      status: 'pending',
      updated_at: '2099-03-01T00:00:00.000Z',
    });
    const headers = bearer(target.token);
    const seeded = [success_id, failed_id, pending_id];
    const mine = (items: { id: string }[]): string[] =>
      items.filter((item) => seeded.includes(item.id)).map((item) => item.id);

    const active = await api.projects.deployments.get({
      $query: { state: 'active', limit: 50 },
      $headers: headers,
    });
    expect(mine(active.data!)).toEqual([pending_id]);

    const succeeded = await api.projects.deployments.get({
      $query: { state: 'success', limit: 50 },
      $headers: headers,
    });
    expect(mine(succeeded.data!)).toEqual([success_id]);

    const failed = await api.projects.deployments.get({
      $query: { state: 'failed', limit: 50 },
      $headers: headers,
    });
    expect(mine(failed.data!)).toEqual([failed_id]);

    const all = await api.projects.deployments.get({
      $query: { state: 'all', limit: 50 },
      $headers: headers,
    });
    expect(mine(all.data!).sort()).toEqual(seeded.sort());
  });

  test('shows every deployment in the install to every signed-in user', async () => {
    const owner = await provision('overview-owner@cc-forge.test');
    const owned_id = await seed_deployment(owner, {
      status: 'success',
      updated_at: '2099-04-01T00:00:00.000Z',
    });

    const other_company = await provision('overview-outsider@cc-forge.test');
    const foreign_id = await seed_deployment(other_company, {
      status: 'success',
      updated_at: '2099-04-02T00:00:00.000Z',
    });

    const owner_view = await api.projects.deployments.get({
      $query: { state: 'all', limit: 50 },
      $headers: bearer(owner.token),
    });
    expect(owner_view.data!.some(({ id }) => id === owned_id)).toBe(true);
    expect(owner_view.data!.some(({ id }) => id === foreign_id)).toBe(true);

    const member = await add_company_member(owner.token, 'overview-member@cc-forge.test');
    const member_view = await api.projects.deployments.get({
      $query: { state: 'all', limit: 50 },
      $headers: bearer(member),
    });
    expect(member_view.data!.some(({ id }) => id === owned_id)).toBe(true);
    expect(member_view.data!.some(({ id }) => id === foreign_id)).toBe(true);
  });

  test('respects the limit', async () => {
    const target = await provision('overview-limit@cc-forge.test');
    await seed_deployment(target, { status: 'success', updated_at: '2026-01-01T00:00:00.000Z' });
    await seed_deployment(target, { status: 'success', updated_at: '2026-02-01T00:00:00.000Z' });
    await seed_deployment(target, { status: 'success', updated_at: '2026-03-01T00:00:00.000Z' });

    const response = await api.projects.deployments.get({
      $query: { state: 'all', limit: 2 },
      $headers: bearer(target.token),
    });
    expect(response.data).toHaveLength(2);
  });

  test('lists the install deployments for a user without a company', async () => {
    const target = await provision('overview-no-company-owner@cc-forge.test');
    const seeded_id = await seed_deployment(target, {
      status: 'success',
      updated_at: '2099-05-01T00:00:00.000Z',
    });

    const token = await authenticate('overview-no-company@cc-forge.test', false);
    const response = await api.projects.deployments.get({
      $query: { state: 'all', limit: 50 },
      $headers: bearer(token),
    });
    expect(response.error).toBeNull();
    expect(response.data!.some(({ id }) => id === seeded_id)).toBe(true);
  });

  test('requires authentication', async () => {
    const response = await api.projects.deployments.get({ $query: { state: 'all', limit: 10 } });
    expect(response.error?.status as number).toBe(401);
  });

  test('rejects an invalid state or an out-of-range limit', async () => {
    const token = await authenticate('overview-validation@cc-forge.test');
    const headers = bearer(token);
    expect(
      (
        await api.projects.deployments.get({
          $query: { state: 'bogus' } as never,
          $headers: headers,
        })
      ).error?.status as number
    ).toBe(422);
    expect(
      (
        await api.projects.deployments.get({
          $query: { state: 'all', limit: 0 },
          $headers: headers,
        })
      ).error?.status as number
    ).toBe(422);
    expect(
      (
        await api.projects.deployments.get({
          $query: { state: 'all', limit: 51 },
          $headers: headers,
        })
      ).error?.status as number
    ).toBe(422);
  });
});

describe('deployment teardown', () => {
  test('deployment info reports whether Stop is available', async () => {
    const { token, project_id } = await provision('deploy-stop-capability@cc-forge.test');
    const accepted = await enqueue(project_id, token);
    await wait_for_status(accepted.deploy_id, 'success');

    const live = await api.projects[project_id]!.deploy[accepted.deploy_id]!.get({
      $headers: bearer(token),
    });
    expect(live.data?.stop).toEqual({ available: true, code: 'available', message: null });

    await db
      .update(deployments)
      .set({ controller_instance_id: null })
      .where(eq(deployments.id, accepted.deploy_id));

    const legacy = await api.projects[project_id]!.deploy[accepted.deploy_id]!.get({
      $headers: bearer(token),
    });
    expect(legacy.data?.stop).toEqual({
      available: false,
      code: 'missing_controller_identity',
      message: 'This deployment predates Stop support. Deploy again before stopping it.',
    });
  });

  test('stops a live deployment, streams the teardown, and frees the project to deploy again', async () => {
    const { token, project_id } = await provision('deploy-stop@cc-forge.test');
    const accepted = await enqueue(project_id, token);
    await wait_for_status(accepted.deploy_id, 'success');

    const stop = await api.projects[project_id]!.deploy[accepted.deploy_id]!.stop.post(undefined, {
      headers: bearer(token),
    });
    expect(stop.error).toBeNull();
    expect(stop.status).toBe(202);
    expect(stop.data).toEqual({ deploy_id: accepted.deploy_id, project_id, status: 'stopping' });

    await wait_for_status(accepted.deploy_id, 'stopped');

    const events = await db
      .select({ seq: deploymentEvents.seq, status: deploymentEvents.status })
      .from(deploymentEvents)
      .where(eq(deploymentEvents.deployment_id, accepted.deploy_id))
      .orderBy(asc(deploymentEvents.seq));
    expect(events.slice(-2).map((event) => event.status)).toEqual(['stopping', 'stopped']);

    // Replay must run past the deploy's own `success` event to the teardown outcome.
    const frames = await read_stream(project_id, accepted.deploy_id, token);
    expect(frames.at(-1)).toEqual({
      id: `${accepted.deploy_id}:${events.at(-1)!.seq}`,
      event: 'stopped',
      data: { type: 'stopped', message: null },
    });
    expect(frames.some((frame) => frame.event === 'phase' && frame.data.phase === 'stopping')).toBe(
      true
    );

    const redeploy = await enqueue(project_id, token);
    expect(redeploy.deploy_id).not.toBe(accepted.deploy_id);
    await wait_for_status(redeploy.deploy_id, 'success');
  });

  test('stops a live deployment even if the stored controller IP is missing', async () => {
    const { token, project_id } = await provision('deploy-stop-without-ip@cc-forge.test');
    const accepted = await enqueue(project_id, token);
    await wait_for_status(accepted.deploy_id, 'success');

    await db
      .update(deployments)
      .set({ controller_ip: null })
      .where(eq(deployments.id, accepted.deploy_id));

    const stop = await api.projects[project_id]!.deploy[accepted.deploy_id]!.stop.post(undefined, {
      headers: bearer(token),
    });
    expect(stop.error).toBeNull();
    expect(stop.status).toBe(202);

    await wait_for_status(accepted.deploy_id, 'stopped');
  });

  test('refuses to stop a deployment that is not live', async () => {
    const { token, project_id } = await provision('deploy-stop-inflight@cc-forge.test');
    set_mock_deploy_script({ hold_at: 'processing_files' });
    const accepted = await enqueue(project_id, token);
    await wait_for_status(accepted.deploy_id, 'processing_files');

    const stop = await api.projects[project_id]!.deploy[accepted.deploy_id]!.stop.post(undefined, {
      headers: bearer(token),
    });
    expect(stop.error?.status as number).toBe(409);
    expect(stop.error?.value).toMatchObject({ error: 'deploy.not_stoppable' });

    release_hold();
    await wait_for_status(accepted.deploy_id, 'success');
  });

  test('answers 404 for a deployment the project does not own', async () => {
    const { token, project_id } = await provision('deploy-stop-404@cc-forge.test');
    const stop = await api.projects[project_id]!.deploy[crypto.randomUUID()]!.stop.post(undefined, {
      headers: bearer(token),
    });
    expect(stop.error?.status as number).toBe(404);
  });

  test('re-requesting an in-flight stop is idempotent', async () => {
    const { token, project_id } = await provision('deploy-stop-twice@cc-forge.test');
    const accepted = await enqueue(project_id, token);
    await wait_for_status(accepted.deploy_id, 'success');

    // Move the row to 'stopping' directly so no mock teardown is racing this assertion.
    expect(await deployments_repo.request_stop(accepted.deploy_id, project_id)).toBeDefined();

    const stop = await api.projects[project_id]!.deploy[accepted.deploy_id]!.stop.post(undefined, {
      headers: bearer(token),
    });
    expect(stop.status).toBe(202);
    expect(stop.data?.status).toBe('stopping');

    const stopping_events = await db
      .select({ seq: deploymentEvents.seq })
      .from(deploymentEvents)
      .where(
        and(
          eq(deploymentEvents.deployment_id, accepted.deploy_id),
          eq(deploymentEvents.status, 'stopping')
        )
      );
    expect(stopping_events).toHaveLength(1);

    await deployments_repo.advance_status_with_event(accepted.deploy_id, 'stopped');
  });

  test('a failed teardown leaves the deployment live and reports why', async () => {
    const { token, project_id } = await provision('deploy-stop-failed@cc-forge.test');
    const accepted = await enqueue(project_id, token);
    await wait_for_status(accepted.deploy_id, 'success');

    set_mock_deploy_script({ stop_throw_message: 'ssh: connect to host 203.0.113.10 port 22' });
    const stop = await api.projects[project_id]!.deploy[accepted.deploy_id]!.stop.post(undefined, {
      headers: bearer(token),
    });
    expect(stop.status).toBe(202);

    await wait_for_condition(async () => {
      const [row] = await db
        .select({ stop_error: deployments.stop_error })
        .from(deployments)
        .where(eq(deployments.id, accepted.deploy_id));
      return row?.stop_error !== null;
    }, 'stop_error to be recorded');

    const info = await api.projects[project_id]!.deploy[accepted.deploy_id]!.get({
      $headers: bearer(token),
    });
    expect(info.data).toMatchObject({
      status: 'success',
      address: '203.0.113.42',
      error: null,
      stop_error: 'ssh: connect to host 203.0.113.10 port 22',
    });

    const [row] = await db
      .select({ stop_claimed_at: deployments.stop_claimed_at })
      .from(deployments)
      .where(eq(deployments.id, accepted.deploy_id));
    expect(row?.stop_claimed_at).toBeNull();

    const frames = await read_stream(project_id, accepted.deploy_id, token);
    expect(frames.at(-1)).toMatchObject({
      event: 'stop_failed',
      data: { type: 'stop_failed', message: 'ssh: connect to host 203.0.113.10 port 22' },
    });

    clear_mock_deploy_script();
    const retry = await api.projects[project_id]!.deploy[accepted.deploy_id]!.stop.post(undefined, {
      headers: bearer(token),
    });
    expect(retry.status).toBe(202);
    await wait_for_status(accepted.deploy_id, 'stopped');
    const [cleared] = await db
      .select({ stop_error: deployments.stop_error })
      .from(deployments)
      .where(eq(deployments.id, accepted.deploy_id));
    expect(cleared?.stop_error).toBeNull();
  });

  test('a teardown that loses its worker is swept instead of hanging in stopping', async () => {
    const { token, project_id } = await provision('deploy-stop-sweep@cc-forge.test');
    const accepted = await enqueue(project_id, token);
    await wait_for_status(accepted.deploy_id, 'success');

    expect(await deployments_repo.request_stop(accepted.deploy_id, project_id)).toBeDefined();
    await db
      .update(deployments)
      .set({ heartbeat_at: sql`now() - make_interval(secs => ${config.deploy.leaseSeconds * 2})` })
      .where(eq(deployments.id, accepted.deploy_id));

    expect(await sweep_stale_deployments()).toBeGreaterThan(0);
    const [row] = await db
      .select({
        status: deployments.status,
        error: deployments.error,
        stop_error: deployments.stop_error,
      })
      .from(deployments)
      .where(eq(deployments.id, accepted.deploy_id));
    expect(row).toMatchObject({
      status: 'success',
      error: null,
      stop_error: 'worker lost while stopping; retry the stop',
    });

    const event = await db
      .select({ status: deploymentEvents.status, detail: deploymentEvents.detail })
      .from(deploymentEvents)
      .where(eq(deploymentEvents.deployment_id, accepted.deploy_id))
      .orderBy(asc(deploymentEvents.seq))
      .then((events) => events.at(-1));
    expect(event).toEqual({
      status: 'stop_failed',
      detail: 'worker lost while stopping; retry the stop',
    });
  });

  test('refuses to stop a legacy successful deployment without controller handles', async () => {
    const { token, project_id } = await provision('deploy-stop-legacy@cc-forge.test');
    const accepted = await enqueue(project_id, token);
    await wait_for_status(accepted.deploy_id, 'success');

    await db
      .update(deployments)
      .set({ controller_instance_id: null })
      .where(eq(deployments.id, accepted.deploy_id));

    const stop = await api.projects[project_id]!.deploy[accepted.deploy_id]!.stop.post(undefined, {
      headers: bearer(token),
    });
    expect(stop.error?.status as number).toBe(409);
    expect(stop.error?.value).toMatchObject({ error: 'deploy.missing_teardown_handles' });
    expect(await deployments_repo.get_status(accepted.deploy_id)).toBe('success');
  });
});
