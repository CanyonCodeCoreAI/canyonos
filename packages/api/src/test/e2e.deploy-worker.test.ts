import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { asc, eq, sql } from 'drizzle-orm';

import { db, sql as postgres } from '@api/db/client';
import { deploymentEvents, deployments } from '@api/db/schema';

import { deployments_repo } from '../modules/deploy/deploy.repo';
import { run_mock_deploy } from '../modules/deploy/deploy.worker.mock';
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
import { api, setupE2ETests } from './e2e.setup';
import { authenticate, bearer, create_deploy_setup } from './project-test.utils';

setupE2ETests();

beforeEach(() => {
  set_workflow_generation_mock(async () => ({
    status: 'failed',
    error_message: 'deploy worker test',
  }));
});

afterEach(async () => {
  release_hold();
  clear_mock_deploy_script();
  await workflows_queue.idle();
  clear_workflow_generation_mock();
});

let fixture_number = 0;

async function insert_pending_deployment() {
  fixture_number += 1;
  const token = await authenticate(`deploy-worker-${fixture_number}@cc-forge.test`);
  const setup = await create_deploy_setup(token);
  const profile = await api.auth.profile.get({ $headers: bearer(token) });
  const project = await api.projects.post(
    {
      name: `Deploy Worker ${fixture_number}`,
      files: [{ path: 'workflow.py', content: 'def run(): pass\n' }],
    },
    { headers: bearer(token) }
  );
  const company_id = profile.data?.company_id;
  const user_id = profile.data?.id;
  const project_id = project.data?.project.id;
  if (!company_id || !user_id || !project_id) throw new Error('Deploy worker fixture failed');

  return deployments_repo.insert_pending_with_event(
    {
      project_id,
      company_id,
      created_by: user_id,
      deploy_setup_id: setup.id,
    },
    []
  );
}

async function wait_for_status(deployment_id: string, status: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [row] = await db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.id, deployment_id));
    if (row?.status === status) return;
    await Bun.sleep(5);
  }
  throw new Error(`deployment ${deployment_id} never reached status ${status}`);
}

async function wait_for_newer_heartbeat(
  deployment_id: string,
  previous_heartbeat_at: string
): Promise<void> {
  const previous_time = new Date(previous_heartbeat_at).getTime();

  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [row] = await db
      .select({ heartbeat_at: deployments.heartbeat_at })
      .from(deployments)
      .where(eq(deployments.id, deployment_id));
    if (row?.heartbeat_at && new Date(row.heartbeat_at).getTime() > previous_time) return;
    await Bun.sleep(5);
  }

  throw new Error(`deployment ${deployment_id} heartbeat did not advance within 1 second`);
}

describe('deploy worker persistence', () => {
  test('keeps a committed pending claim exclusive', async () => {
    const deployment = await insert_pending_deployment();

    const first = await deployments_repo.claim_pending(deployment.id, 'worker-a');
    const second = await deployments_repo.claim_pending(deployment.id, 'worker-b');

    expect(first).toMatchObject({ id: deployment.id, worker_version: 'worker-a', attempts: 1 });
    expect(second).toBeUndefined();

    const [stored] = await db
      .select({ worker_version: deployments.worker_version, attempts: deployments.attempts })
      .from(deployments)
      .where(eq(deployments.id, deployment.id));
    expect(stored).toEqual({ worker_version: 'worker-a', attempts: 1 });
    await deployments_repo.mark_failed_with_event(deployment.id, 'test complete');
  });

  test('leaves unclaimed pending work queued and fails claimed stale work with its event', async () => {
    const deployment = await insert_pending_deployment();

    expect(await deployments_repo.sweep_stale(0)).toBe(0);
    expect(await deployments_repo.get_status(deployment.id)).toBe('pending');

    await deployments_repo.claim_pending(deployment.id, 'worker-a');
    await db
      .update(deployments)
      .set({ heartbeat_at: sql`now() - interval '10 minutes'` })
      .where(eq(deployments.id, deployment.id));

    expect(await deployments_repo.sweep_stale(60)).toBe(1);

    const [stored] = await db
      .select({ status: deployments.status, error: deployments.error })
      .from(deployments)
      .where(eq(deployments.id, deployment.id));
    const events = await db
      .select({ seq: deploymentEvents.seq, status: deploymentEvents.status })
      .from(deploymentEvents)
      .where(eq(deploymentEvents.deployment_id, deployment.id))
      .orderBy(asc(deploymentEvents.seq));

    expect(stored).toEqual({ status: 'failed', error: 'worker lost' });
    expect(events).toEqual([
      { seq: 1, status: 'pending' },
      { seq: 2, status: 'failed' },
    ]);
  });

  test('rolls back the stale status when its terminal event cannot be written', async () => {
    const deployment = await insert_pending_deployment();
    await deployments_repo.claim_pending(deployment.id, 'worker-a');
    await db
      .update(deployments)
      .set({ heartbeat_at: sql`now() - interval '10 minutes'` })
      .where(eq(deployments.id, deployment.id));

    const suffix = deployment.id.replaceAll('-', '');
    const function_name = `test_fail_sweep_${suffix}`;
    const trigger_name = `test_fail_sweep_${suffix}`;

    try {
      await postgres.unsafe(`
        CREATE FUNCTION "${function_name}"() RETURNS trigger AS $$
        BEGIN
          IF NEW.deployment_id = '${deployment.id}'::uuid
             AND NEW.status = 'failed'
             AND NEW.detail = 'worker lost' THEN
            RAISE EXCEPTION 'forced sweep event failure';
          END IF;
          RETURN NEW;
        END
        $$ LANGUAGE plpgsql
      `);
      await postgres.unsafe(`
        CREATE TRIGGER "${trigger_name}"
        BEFORE INSERT ON deployment_events
        FOR EACH ROW EXECUTE FUNCTION "${function_name}"()
      `);

      let sweep_error: unknown;
      try {
        await deployments_repo.sweep_stale(60);
      } catch (error) {
        sweep_error = error;
      }
      expect(sweep_error).toBeDefined();
      expect((sweep_error as { cause?: Error }).cause?.message).toContain(
        'forced sweep event failure'
      );
    } finally {
      await postgres.unsafe(`DROP TRIGGER IF EXISTS "${trigger_name}" ON deployment_events`);
      await postgres.unsafe(`DROP FUNCTION IF EXISTS "${function_name}"()`);
    }

    const [stored] = await db
      .select({ status: deployments.status, error: deployments.error })
      .from(deployments)
      .where(eq(deployments.id, deployment.id));
    const events = await db
      .select({ status: deploymentEvents.status })
      .from(deploymentEvents)
      .where(eq(deploymentEvents.deployment_id, deployment.id));

    expect(stored).toEqual({ status: 'pending', error: null });
    expect(events).toEqual([{ status: 'pending' }]);
  });
});

describe('mock deploy worker lifecycle', () => {
  test('turns an unexpected worker exception into a terminal failure', async () => {
    const deployment = await insert_pending_deployment();
    set_mock_deploy_script({
      throw_at: 'processing_files',
      throw_message: 'unexpected mock crash',
    });

    await run_mock_deploy(deployment.id);

    const [stored] = await db
      .select({ status: deployments.status, error: deployments.error })
      .from(deployments)
      .where(eq(deployments.id, deployment.id));
    const events = await db
      .select({ status: deploymentEvents.status, detail: deploymentEvents.detail })
      .from(deploymentEvents)
      .where(eq(deploymentEvents.deployment_id, deployment.id))
      .orderBy(asc(deploymentEvents.seq));

    expect(stored).toEqual({ status: 'failed', error: 'unexpected mock crash' });
    expect(events).toEqual([
      { status: 'pending', detail: null },
      { status: 'receiving_files', detail: null },
      { status: 'failed', detail: 'unexpected mock crash' },
    ]);
  });

  test('keeps heartbeating while a deterministic test hold is active', async () => {
    const deployment = await insert_pending_deployment();
    set_mock_deploy_script({ hold_at: 'receiving_files', heartbeat_interval_ms: 10 });

    const running = run_mock_deploy(deployment.id);
    await wait_for_status(deployment.id, 'receiving_files');
    const [before] = await db
      .select({ heartbeat_at: deployments.heartbeat_at })
      .from(deployments)
      .where(eq(deployments.id, deployment.id));
    expect(before?.heartbeat_at).not.toBeNull();
    await wait_for_newer_heartbeat(deployment.id, before!.heartbeat_at!);

    release_hold();
    await running;
    expect(await deployments_repo.get_status(deployment.id)).toBe('success');
  });
});
