import { describe, expect, test } from 'bun:test';

import { db } from '@api/db/client';
import { deployments } from '@api/db/schema';
import { config } from '@core/env';

import { api, setupE2ETests } from './e2e.setup';
import { authenticate, bearer, create_deploy_setup } from './project-test.utils';

setupE2ETests();

async function provision(email: string) {
  const token = await authenticate(email);
  await create_deploy_setup(token);
  const project = await api.projects.post(
    { name: 'Deploy Project', files: [{ path: 'workflow.py', content: 'def run(): pass\n' }] },
    { headers: bearer(token) }
  );
  expect(project.error).toBeNull();
  return { token, project_id: project.data!.project.id };
}

describe('DEPLOY_WORKER=none refuses to deploy', () => {
  test('the suite runs with no deploy worker', () => {
    expect(config.deploy.worker).toBe('none');
  });

  test('triggering a deploy answers 409 and writes no deployment row', async () => {
    const { token, project_id } = await provision('deploy-disabled-trigger@canyonos.test');

    const response = await api.projects[project_id]!.deploy.post({}, { headers: bearer(token) });

    expect(response.error?.status as number).toBe(409);
    expect((response.error?.value as { error?: string })?.error).toBe('deploy.unavailable');
    expect(await db.select({ id: deployments.id }).from(deployments)).toBeEmpty();
  });

  // A deployment that does not exist would normally answer 404, so a 409 here proves the guard runs
  // before the lookup — and therefore before `request_stop` can write.
  test('stopping answers 409 before it looks the deployment up', async () => {
    const { token, project_id } = await provision('deploy-disabled-stop@canyonos.test');

    const stop = await api.projects[project_id]!.deploy[crypto.randomUUID()]!.stop.post(undefined, {
      headers: bearer(token),
    });

    expect(stop.error?.status as number).toBe(409);
    expect((stop.error?.value as { error?: string })?.error).toBe('deploy.unavailable');
  });

  test('an unauthenticated deploy is still rejected as unauthorized', async () => {
    const { project_id } = await provision('deploy-disabled-anon@canyonos.test');

    const response = await api.projects[project_id]!.deploy.post({});

    expect(response.error?.status as number).toBe(401);
  });
});
