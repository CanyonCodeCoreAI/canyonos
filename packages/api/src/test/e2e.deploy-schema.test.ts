import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';

import { db } from '@api/db/client';
import { deploymentEvents, deployments } from '@api/db/schema';
import { config } from '@core/env';

import { api, setupE2ETests } from './e2e.setup';
import { authenticate, bearer, create_deploy_setup } from './project-test.utils';

setupE2ETests();

// Above the 8000-byte payload ceiling NOTIFY enforces, so an event trigger that published `detail`
// would fail this insert.
const OVERSIZED_DETAIL = 'x'.repeat(9_000);

const NOTIFY_TIMEOUT_MS = 5_000;

let fixture_number = 0;

interface DeployOwner {
  readonly project_id: string;
  readonly company_id: string;
  readonly created_by: string;
  readonly deploy_setup_id: string;
}

async function create_deploy_owner(): Promise<DeployOwner> {
  fixture_number += 1;
  const token = await authenticate(`deploy-schema-${fixture_number}@cc-forge.test`);
  const setup = await create_deploy_setup(token);
  const profile = await api.auth.profile.get({ $headers: bearer(token) });
  const project = await api.projects.post(
    {
      name: `Deploy Schema ${fixture_number}`,
      files: [{ path: 'workflow.py', content: 'def run(): pass\n' }],
    },
    { headers: bearer(token) }
  );
  const company_id = profile.data?.company_id;
  const created_by = profile.data?.id;
  const project_id = project.data?.project.id;
  if (!company_id || !created_by || !project_id) throw new Error('Deploy schema fixture failed');
  return { project_id, company_id, created_by, deploy_setup_id: setup.id };
}

async function enqueue(owner: DeployOwner, status: 'pending' | 'success'): Promise<string> {
  const [row] = await db
    .insert(deployments)
    .values({ ...owner, status })
    .returning({
      id: deployments.id,
    });
  if (!row) throw new Error('Deployment insert returned no row');
  return row.id;
}

const set_status = (id: string, status: 'stopped' | 'stopping') =>
  db.update(deployments).set({ status }).where(eq(deployments.id, id));

// Drizzle wraps the driver error, so the violated index is only readable through the cause.
const violated_constraint = (error: unknown): string | undefined =>
  (error as { cause?: { constraint_name?: string } }).cause?.constraint_name;

describe('deploy schema contracts', () => {
  test('an event detail above the NOTIFY limit is stored in full', async () => {
    const owner = await create_deploy_owner();
    const deployment_id = await enqueue(owner, 'pending');

    await db
      .insert(deploymentEvents)
      .values({ deployment_id, seq: 1, status: 'failed', detail: OVERSIZED_DETAIL });

    const [stored] = await db
      .select({ detail: deploymentEvents.detail })
      .from(deploymentEvents)
      .where(eq(deploymentEvents.deployment_id, deployment_id));
    expect(stored?.detail).toHaveLength(OVERSIZED_DETAIL.length);
  });

  test('a project holds at most one active deployment', async () => {
    const owner = await create_deploy_owner();
    await enqueue(owner, 'pending');

    const collision = await enqueue(owner, 'pending').catch((error: unknown) => error);
    expect(violated_constraint(collision)).toBe('uq_deployments_active_per_project');
  });

  test('a torn-down deployment releases the project slot', async () => {
    const owner = await create_deploy_owner();
    const first = await enqueue(owner, 'pending');

    await set_status(first, 'stopped');
    const second = await enqueue(owner, 'pending');

    // 'stopping' is outside the guard as well, so the database accepts a deploy requested
    // mid-teardown — TERMINAL in deploy.repo.ts is what answers 409 for that.
    await set_status(second, 'stopping');
    await enqueue(owner, 'pending');
  });

  test('entering teardown wakes the deploy worker', async () => {
    const owner = await create_deploy_owner();
    const deployment_id = await enqueue(owner, 'success');

    const listener = postgres(config.database.url, { max: 1, onnotice: () => undefined });
    let announce = (_payload: string): void => undefined;
    const woken = new Promise<string>((resolve) => {
      announce = resolve;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await listener.listen('deploy_jobs', (payload) => {
        if (payload === deployment_id) announce(payload);
      });
      await set_status(deployment_id, 'stopping');

      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('no deploy_jobs notification')),
          NOTIFY_TIMEOUT_MS
        );
      });
      expect(await Promise.race([woken, timeout])).toBe(deployment_id);
    } finally {
      clearTimeout(timer);
      await listener.end();
    }
  });
});
