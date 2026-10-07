import { beforeEach, describe, expect, test } from 'bun:test';

import { api, setupE2ETests } from './e2e.setup';
import { authenticate, bearer, create_test_project } from './project-test.utils';
import {
  read_scaling_config,
  reset_controller,
  seed_active_agents,
  seed_running_project,
  seed_scaling,
  seed_scaling_agents,
} from './redis-test.utils';
import type { ScalingPolicy } from '../modules/scaling/scaling.types';

setupE2ETests();

const error_code = (res: { error: { value?: unknown } | null }) =>
  (res.error?.value as { error?: string } | undefined)?.error;

const POLICY: ScalingPolicy = {
  min_replicas: 1,
  max_replicas: 6,
  metric: 'requests_per_minute_per_replica',
  scale_up_above: 10,
  scale_down_below: 1,
};

// The GC publishes config/scaling.yaml as-is, so the document can carry keys besides `scaling`.
const CONFIG = { scaling: POLICY, owner: 'platform' };

async function running_project(
  email: string,
  scaling_config: string | null = JSON.stringify(CONFIG)
): Promise<{ token: string; project_id: string }> {
  const token = await authenticate(email);
  const { project_id } = await create_test_project(token, { name: 'Scaling Project' });
  await seed_running_project(project_id, { prompts: {} });
  if (scaling_config !== null) await seed_scaling(scaling_config);
  return { token, project_id };
}

describe('project scaling policy', () => {
  beforeEach(reset_controller);

  test('returns the stored policy as applied', async () => {
    const { token, project_id } = await running_project('scaling-get@canyonos.test');

    const res = await api.projects[project_id]!.scaling.get({ $headers: bearer(token) });

    expect(res.error).toBeNull();
    expect(res.data).toEqual({ status: 'applied', policy: POLICY });
  });

  test('a controller with no scaling config has no policy, and the first save creates it', async () => {
    const { token, project_id } = await running_project('scaling-bare@canyonos.test', null);
    const headers = bearer(token);

    const listed = await api.projects[project_id]!.scaling.get({ $headers: headers });
    expect(listed.error).toBeNull();
    expect(listed.data).toEqual({ status: 'none' });

    const saved = await api.projects[project_id]!.scaling.put(POLICY, { headers });
    expect(saved.error).toBeNull();
    expect(saved.data).toEqual(POLICY);
    expect(await read_scaling_config()).toEqual({ scaling: POLICY });
  });

  test('saving over the stored policy replaces it and keeps the other keys', async () => {
    const { token, project_id } = await running_project('scaling-replace@canyonos.test');
    const headers = bearer(token);
    const edited: ScalingPolicy = { ...POLICY, max_replicas: 3, scale_up_above: 20 };

    const saved = await api.projects[project_id]!.scaling.put(edited, { headers });

    expect(saved.error).toBeNull();
    expect(saved.data).toEqual(edited);
    expect(await read_scaling_config()).toEqual({ ...CONFIG, scaling: edited });
    const listed = await api.projects[project_id]!.scaling.get({ $headers: headers });
    expect(listed.data).toEqual({ status: 'applied', policy: edited });
  });

  test('a save strips fields the policy does not have', async () => {
    const { token, project_id } = await running_project('scaling-strip@canyonos.test', null);

    const saved = await api.projects[project_id]!.scaling.put(
      { ...POLICY, agent_name: 'PriceAgent' } as ScalingPolicy,
      { headers: bearer(token) }
    );

    expect(saved.error).toBeNull();
    expect(await read_scaling_config()).toEqual({ scaling: POLICY });
  });

  test('an invalid policy is 422 and nothing is stored', async () => {
    const { token, project_id } = await running_project('scaling-invalid@canyonos.test');
    const headers = bearer(token);
    const invalid = [
      { ...POLICY, min_replicas: 5, max_replicas: 2 },
      { ...POLICY, scale_down_below: 10, scale_up_above: 10 },
      { ...POLICY, scale_down_below: 12, scale_up_above: 10 },
      { ...POLICY, scale_down_below: -1 },
      { ...POLICY, min_replicas: -1 },
      { ...POLICY, min_replicas: 0 },
      { ...POLICY, min_replicas: 0, max_replicas: 0 },
      { ...POLICY, max_replicas: 2.5 },
      { ...POLICY, metric: 'cpu_percent' },
      { min_replicas: 1, max_replicas: 2, metric: 'queue_length_total', scale_up_above: 3 },
    ];

    const responses = await Promise.all(
      invalid.map((body) =>
        api.projects[project_id]!.scaling.put(body as ScalingPolicy, { headers })
      )
    );

    for (const res of responses) {
      expect(res.error?.status as number).toBe(422);
    }
    expect(await read_scaling_config()).toEqual(CONFIG);
  });

  test('a project the controller is not running is 404 canyonos.project_not_running', async () => {
    const token = await authenticate('scaling-not-running@canyonos.test');
    const headers = bearer(token);
    const { project_id } = await create_test_project(token, { name: 'Idle Project' });
    const { project_id: running_id } = await create_test_project(token, { name: 'Running' });
    await seed_running_project(running_id, { prompts: {} });
    await seed_scaling(JSON.stringify(CONFIG));
    const scaling = api.projects[project_id]!.scaling;

    const responses = await Promise.all([
      scaling.get({ $headers: headers }),
      scaling.put(POLICY, { headers }),
      scaling.delete(undefined, { headers }),
      scaling.agents.get({ $headers: headers }),
    ]);

    for (const res of responses) {
      expect(res.error?.status as number).toBe(404);
      expect(error_code(res)).toBe('canyonos.project_not_running');
    }
    expect(await read_scaling_config()).toEqual(CONFIG);
  });

  test('a caller with no token is rejected on every route', async () => {
    const { project_id } = await running_project('scaling-anon@canyonos.test');
    const scaling = api.projects[project_id]!.scaling;

    const responses = await Promise.all([
      scaling.get(),
      scaling.put(POLICY),
      scaling.delete(),
      scaling.agents.get(),
    ]);

    for (const res of responses) {
      expect(res.error?.status as number).toBe(401);
    }
    expect(await read_scaling_config()).toEqual(CONFIG);
  });

  test('a project that does not exist is 404 projects.not_found on every route', async () => {
    const token = await authenticate('scaling-missing@canyonos.test');
    const headers = bearer(token);
    const scaling = api.projects['11111111-1111-4111-8111-111111111111']!.scaling;

    const responses = await Promise.all([
      scaling.get({ $headers: headers }),
      scaling.put(POLICY, { headers }),
      scaling.delete(undefined, { headers }),
      scaling.agents.get({ $headers: headers }),
    ]);

    for (const res of responses) {
      expect(res.error?.status as number).toBe(404);
      expect(error_code(res)).toBe('projects.not_found');
    }
  });

  // One install serves one team, so any signed-in user reaches the running project's policy.
  test('another signed-in user can read and change the policy', async () => {
    const { project_id } = await running_project('scaling-owner@canyonos.test');
    const other = await authenticate('scaling-other@canyonos.test');
    const headers = bearer(other);

    const listed = await api.projects[project_id]!.scaling.get({ $headers: headers });
    const saved = await api.projects[project_id]!.scaling.put(
      { ...POLICY, max_replicas: 2 },
      { headers }
    );

    expect(listed.data).toEqual({ status: 'applied', policy: POLICY });
    expect(saved.error).toBeNull();
    expect(await read_scaling_config()).toEqual({
      ...CONFIG,
      scaling: { ...POLICY, max_replicas: 2 },
    });
  });

  // Without WATCH/MULTI a burst could interleave writes; with it every write lands or is told to retry.
  test('a burst of saves never loses one: each is stored or answered 409 scaling.save_conflict', async () => {
    const { token, project_id } = await running_project('scaling-burst@canyonos.test', null);
    const headers = bearer(token);
    const policies = Array.from({ length: 12 }, (_, index) => ({
      ...POLICY,
      max_replicas: index + 1,
    }));

    const responses = await Promise.all(
      policies.map((policy) => api.projects[project_id]!.scaling.put(policy, { headers }))
    );

    const stored = policies.filter((_, index) => responses[index]!.error === null);
    for (const res of responses.filter(({ error }) => error !== null)) {
      expect(res.error?.status as number).toBe(409);
      expect(error_code(res)).toBe('scaling.save_conflict');
    }
    expect(stored.length).toBeGreaterThan(0);
    const final = (await read_scaling_config()) as { scaling: ScalingPolicy };
    expect(stored).toContainEqual(final.scaling);
  });

  test('a save racing a delete ends with the policy stored or gone, never half-written', async () => {
    const { token, project_id } = await running_project('scaling-race@canyonos.test');
    const headers = bearer(token);
    const scaling = api.projects[project_id]!.scaling;

    const [saved, deleted] = await Promise.all([
      scaling.put({ ...POLICY, max_replicas: 2 }, { headers }),
      scaling.delete(undefined, { headers }),
    ]);

    for (const res of [saved, deleted]) {
      if (res.error) expect(res.error.status as number).toBe(409);
    }
    const final = (await read_scaling_config()) as { scaling: ScalingPolicy | null };
    expect([null, { ...POLICY, max_replicas: 2 }]).toContainEqual(final.scaling);
  });

  // A corrupt scaling:config is the controller's fault, reported as 502 like prompts.config_invalid.
  test('a corrupt config is 502 scaling.config_invalid on the policy routes', async () => {
    const { token, project_id } = await running_project(
      'scaling-corrupt-all@canyonos.test',
      '{oops'
    );
    const headers = bearer(token);
    const scaling = api.projects[project_id]!.scaling;

    const responses = await Promise.all([
      scaling.get({ $headers: headers }),
      scaling.put(POLICY, { headers }),
      scaling.delete(undefined, { headers }),
    ]);

    for (const res of responses) {
      expect(res.error?.status as number).toBe(502);
      expect(error_code(res)).toBe('scaling.config_invalid');
    }
  });

  // A hand-written scaling.yaml can hold a policy the controller skips; the dashboard must say why.
  test('a stored policy that fails validation is reported invalid with its first broken rule', async () => {
    const cases = [
      {
        scaling: { ...POLICY, min_replicas: 4, max_replicas: 2 },
        reason: 'max_replicas: max_replicas must be greater than or equal to min_replicas',
      },
      {
        scaling: { ...POLICY, metric: 'cpu' },
        reason:
          "metric: Invalid enum value. Expected 'queue_length_total' | 'requests_per_minute_per_replica', received 'cpu'",
      },
      {
        scaling: { PriceAgent: POLICY, MetricsAgent: POLICY },
        reason:
          "the policy is keyed by agent name (PriceAgent, MetricsAgent); scaling.yaml now holds one policy for the whole workflow, so move one agent's fields up to the top level",
      },
      { scaling: {}, reason: 'min_replicas: Required' },
      { scaling: ['PriceAgent'], reason: 'Expected object, received array' },
    ];
    for (const [index, { scaling, reason }] of cases.entries()) {
      await reset_controller();
      const config = { scaling, owner: 'platform' };
      const { token, project_id } = await running_project(
        `scaling-invalid-stored-${index}@canyonos.test`,
        JSON.stringify(config)
      );

      const res = await api.projects[project_id]!.scaling.get({ $headers: bearer(token) });

      expect(res.error).toBeNull();
      expect(res.data).toEqual({ status: 'invalid', reason });
      expect(await read_scaling_config()).toEqual(config);
    }
  });

  test('deleting the policy clears it and keeps the other keys', async () => {
    const { token, project_id } = await running_project('scaling-delete@canyonos.test');
    const headers = bearer(token);

    const deleted = await api.projects[project_id]!.scaling.delete(undefined, { headers });

    expect(deleted.error).toBeNull();
    expect(deleted.data).toEqual({ status: 'none' });
    expect(await read_scaling_config()).toEqual({ ...CONFIG, scaling: null });
    const listed = await api.projects[project_id]!.scaling.get({ $headers: headers });
    expect(listed.data).toEqual({ status: 'none' });
  });

  test('an invalid stored policy can be deleted', async () => {
    const { token, project_id } = await running_project(
      'scaling-delete-invalid@canyonos.test',
      JSON.stringify({ scaling: { ...POLICY, min_replicas: 0 } })
    );

    const res = await api.projects[project_id]!.scaling.delete(undefined, {
      headers: bearer(token),
    });

    expect(res.error).toBeNull();
    expect(await read_scaling_config()).toEqual({ scaling: null });
  });

  test('deleting when no policy is stored is 404 scaling.policy_not_found and creates nothing', async () => {
    const { token, project_id } = await running_project('scaling-delete-bare@canyonos.test', null);

    const res = await api.projects[project_id]!.scaling.delete(undefined, {
      headers: bearer(token),
    });

    expect(res.error?.status as number).toBe(404);
    expect(error_code(res)).toBe('scaling.policy_not_found');
    expect(await read_scaling_config()).toBeNull();
  });
});

describe('project scaling agents', () => {
  beforeEach(reset_controller);

  const SAMPLE = {
    replicas_running: 2,
    replicas_expected: 2,
    queue_length_total: 3,
    requests_per_minute_per_replica: 12.5,
    observed_at: 1_800_000_000.25,
  };

  test('lists the agents the policy applies to, in controller order, with their newest load', async () => {
    const { token, project_id } = await running_project('scaling-agents@canyonos.test');
    await seed_scaling_agents([
      { name: 'PriceAgent', replicas: 1, desired: 2, sample: SAMPLE },
      { name: 'IntentAgent', replicas: 1 },
      { name: 'Workflow', type: 'workflow', replicas: 1, sample: SAMPLE },
      { name: 'StateDB', type: 'database' },
    ]);

    const res = await api.projects[project_id]!.scaling.agents.get({ $headers: bearer(token) });

    expect(res.error).toBeNull();
    expect(res.data).toEqual({
      agents: [
        {
          name: 'PriceAgent',
          replicas_expected: 2,
          replicas_running: 2,
          load: {
            queue_length_total: 3,
            requests_per_minute_per_replica: 12.5,
            observed_at: '2027-01-15T08:00:00.250Z',
          },
        },
        { name: 'IntentAgent', replicas_expected: 1, replicas_running: 0, load: null },
      ],
    });
  });

  test('an agent with no desired count yet reports its configured replicas', async () => {
    const { token, project_id } = await running_project('scaling-agents-config@canyonos.test');
    await seed_scaling_agents([{ name: 'PriceAgent', replicas: 3 }]);

    const res = await api.projects[project_id]!.scaling.agents.get({ $headers: bearer(token) });

    expect(res.data).toEqual({
      agents: [{ name: 'PriceAgent', replicas_expected: 3, replicas_running: 0, load: null }],
    });
  });

  test('a controller that has published no agents lists none', async () => {
    const { token, project_id } = await running_project('scaling-agents-none@canyonos.test');

    const res = await api.projects[project_id]!.scaling.agents.get({ $headers: bearer(token) });

    expect(res.error).toBeNull();
    expect(res.data).toEqual({ agents: [] });
  });

  test('a corrupt spec hides that agent, a corrupt sample hides its load, a bad count falls back', async () => {
    const { token, project_id } = await running_project('scaling-agents-bad@canyonos.test');
    await seed_scaling_agents([
      { name: 'PriceAgent', replicas: 1.5, desired: 2, sample: SAMPLE },
      { name: 'RiskAgent', replicas: 2, desired: 'two' as unknown as number },
      { name: 'IntentAgent', raw_spec: '{oops' },
      { name: 'MetricsAgent', raw_sample: '{oops' },
    ]);

    const res = await api.projects[project_id]!.scaling.agents.get({ $headers: bearer(token) });

    expect(res.error).toBeNull();
    expect(res.data).toEqual({
      agents: [
        { name: 'PriceAgent', replicas_expected: 2, replicas_running: 2, load: expect.any(Object) },
        { name: 'RiskAgent', replicas_expected: 2, replicas_running: 0, load: null },
        { name: 'MetricsAgent', replicas_expected: 1, replicas_running: 0, load: null },
      ],
    });
  });

  test('a corrupt agents:active is 502 scaling.config_invalid', async () => {
    const { token, project_id } = await running_project('scaling-agents-list-bad@canyonos.test');
    await seed_scaling_agents([{ name: 'PriceAgent' }]);
    await seed_active_agents('{oops');

    const res = await api.projects[project_id]!.scaling.agents.get({ $headers: bearer(token) });

    expect(res.error?.status as number).toBe(502);
    expect(error_code(res)).toBe('scaling.config_invalid');
  });

  test('a corrupt scaling config does not stop the agents from being listed', async () => {
    const { token, project_id } = await running_project(
      'scaling-agents-corrupt@canyonos.test',
      '{oops'
    );
    await seed_scaling_agents([{ name: 'PriceAgent' }]);

    const res = await api.projects[project_id]!.scaling.agents.get({ $headers: bearer(token) });

    expect(res.error).toBeNull();
    expect(res.data?.agents.map((agent) => agent.name)).toEqual(['PriceAgent']);
  });
});
