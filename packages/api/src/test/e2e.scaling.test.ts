// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, test } from 'bun:test';

import { api, setupE2ETests } from './e2e.setup';
import {
  read_scaling_config,
  reset_controller,
  seed_active_agents,
  seed_running_workflow,
  seed_scaling,
  seed_scaling_agents,
  seed_workflows,
} from './redis-test.utils';
import { bearer, create_test_workflow, TEST_API_KEY } from './workflow-test.utils';
import type { ScalingPolicy } from '../modules/scaling/scaling.types';

setupE2ETests();

const key_headers = bearer(TEST_API_KEY);

const error_code = (res: { error: { value?: unknown } | null }) =>
  (res.error?.value as { error?: string } | undefined)?.error;

const POLICY: ScalingPolicy = {
  min_replicas: 1,
  max_replicas: 6,
  metric: 'requests_per_minute_per_replica',
  scale_up_above: 10,
  scale_down_below: 1,
};

// The GC publishes each workflow's config/scaling.yaml by workflow name, so the document can carry
// keys besides `workflows`.
const CONFIG = { workflows: { app: POLICY }, owner: 'platform' };

/** A running workflow group of one workflow, `app`, whose agents are named `app.<agent>`. */
async function running_workflow(
  scaling_config: string | null = JSON.stringify(CONFIG),
  agents: readonly string[] = ['app.Alpha']
): Promise<{ token: string; workflow_id: string }> {
  const token = TEST_API_KEY;
  const { workflow_id } = await create_test_workflow({ name: 'Scaling Workflow' });
  await seed_running_workflow(workflow_id, { prompts: {} });
  await seed_active_agents(JSON.stringify(agents));
  if (scaling_config !== null) await seed_scaling(scaling_config);
  return { token, workflow_id };
}

describe('workflow scaling policy', () => {
  beforeEach(reset_controller);

  test('returns the stored policy as applied', async () => {
    const { token, workflow_id } = await running_workflow();

    const res = await api.workflows[workflow_id]!.scaling.get({ $headers: bearer(token) });

    expect(res.error).toBeNull();
    expect(res.data).toEqual({ workflows: { app: { status: 'applied', policy: POLICY } } });
  });

  test('a controller with no scaling config has no policy, and the first save creates it', async () => {
    const { token, workflow_id } = await running_workflow(null);
    const headers = bearer(token);

    const listed = await api.workflows[workflow_id]!.scaling.get({ $headers: headers });
    expect(listed.error).toBeNull();
    expect(listed.data).toEqual({ workflows: { app: { status: 'none' } } });

    const saved = await api.workflows[workflow_id]!.scaling.put(POLICY, { headers: key_headers });
    expect(saved.error).toBeNull();
    expect(saved.data).toEqual(POLICY);
    expect(await read_scaling_config()).toEqual({ workflows: { app: POLICY } });
  });

  test('saving over the stored policy replaces it and keeps the other keys', async () => {
    const { token, workflow_id } = await running_workflow();
    const headers = bearer(token);
    const edited: ScalingPolicy = { ...POLICY, max_replicas: 3, scale_up_above: 20 };

    const saved = await api.workflows[workflow_id]!.scaling.put(edited, { headers: key_headers });

    expect(saved.error).toBeNull();
    expect(saved.data).toEqual(edited);
    expect(await read_scaling_config()).toEqual({ ...CONFIG, workflows: { app: edited } });
    const listed = await api.workflows[workflow_id]!.scaling.get({ $headers: headers });
    expect(listed.data).toEqual({ workflows: { app: { status: 'applied', policy: edited } } });
  });

  test('a save strips fields the policy does not have', async () => {
    const { workflow_id } = await running_workflow(null);

    const saved = await api.workflows[workflow_id]!.scaling.put(
      { ...POLICY, agent_name: 'app.PriceAgent' } as ScalingPolicy,
      { headers: key_headers }
    );

    expect(saved.error).toBeNull();
    expect(await read_scaling_config()).toEqual({ workflows: { app: POLICY } });
  });

  test('an invalid policy is 422 and nothing is stored', async () => {
    const { workflow_id } = await running_workflow();
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
        api.workflows[workflow_id]!.scaling.put(body as ScalingPolicy, { headers: key_headers })
      )
    );

    for (const res of responses) {
      expect(res.error?.status as number).toBe(422);
    }
    expect(await read_scaling_config()).toEqual(CONFIG);
  });

  test('a workflow the controller is not running is 404 registry.workflow_not_running', async () => {
    const token = TEST_API_KEY;
    const headers = bearer(token);
    const { workflow_id } = await create_test_workflow({ name: 'Idle Workflow' });
    const { workflow_id: running_id } = await create_test_workflow({ name: 'Running' });
    await seed_running_workflow(running_id, { prompts: {} });
    await seed_scaling(JSON.stringify(CONFIG));
    const scaling = api.workflows[workflow_id]!.scaling;

    const responses = await Promise.all([
      scaling.get({ $headers: headers }),
      scaling.put(POLICY, { headers: key_headers }),
      scaling.delete(undefined, { headers: key_headers }),
      scaling.agents.get({ $headers: headers }),
    ]);

    for (const res of responses) {
      expect(res.error?.status as number).toBe(404);
      expect(error_code(res)).toBe('registry.workflow_not_running');
    }
    expect(await read_scaling_config()).toEqual(CONFIG);
  });

  test('a caller with no API key is rejected on every route', async () => {
    const { workflow_id } = await running_workflow();
    const scaling = api.workflows[workflow_id]!.scaling;

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

  test('a workflow that does not exist is 404 workflows.not_found on every route', async () => {
    const token = TEST_API_KEY;
    const headers = bearer(token);
    const scaling = api.workflows['11111111-1111-4111-8111-111111111111']!.scaling;

    const responses = await Promise.all([
      scaling.get({ $headers: headers }),
      scaling.put(POLICY, { headers: key_headers }),
      scaling.delete(undefined, { headers: key_headers }),
      scaling.agents.get({ $headers: headers }),
    ]);

    for (const res of responses) {
      expect(res.error?.status as number).toBe(404);
      expect(error_code(res)).toBe('workflows.not_found');
    }
  });

  // The API key covers the whole install, so it reaches every workflow's policy.
  test('the API key reads and changes the policy', async () => {
    const { workflow_id } = await running_workflow();
    const headers = bearer(TEST_API_KEY);

    const listed = await api.workflows[workflow_id]!.scaling.get({ $headers: headers });
    const saved = await api.workflows[workflow_id]!.scaling.put(
      { ...POLICY, max_replicas: 2 },
      { headers: key_headers }
    );

    expect(listed.data).toEqual({ workflows: { app: { status: 'applied', policy: POLICY } } });
    expect(saved.error).toBeNull();
    expect(await read_scaling_config()).toEqual({
      ...CONFIG,
      workflows: { app: { ...POLICY, max_replicas: 2 } },
    });
  });

  // Without WATCH/MULTI a burst could interleave writes; with it every write lands or is told to retry.
  test('a burst of saves never loses one: each is stored or answered 409 scaling.save_conflict', async () => {
    const { workflow_id } = await running_workflow(null);
    const policies = Array.from({ length: 12 }, (_, index) => ({
      ...POLICY,
      max_replicas: index + 1,
    }));

    const responses = await Promise.all(
      policies.map((policy) =>
        api.workflows[workflow_id]!.scaling.put(policy, { headers: key_headers })
      )
    );

    const stored = policies.filter((_, index) => responses[index]!.error === null);
    for (const res of responses.filter(({ error }) => error !== null)) {
      expect(res.error?.status as number).toBe(409);
      expect(error_code(res)).toBe('scaling.save_conflict');
    }
    expect(stored.length).toBeGreaterThan(0);
    const final = (await read_scaling_config()) as { workflows: Record<string, ScalingPolicy> };
    expect(stored).toContainEqual(final.workflows.app!);
  });

  test('a save racing a delete ends with the policy stored or gone, never half-written', async () => {
    const { workflow_id } = await running_workflow();
    const scaling = api.workflows[workflow_id]!.scaling;

    const [saved, deleted] = await Promise.all([
      scaling.put({ ...POLICY, max_replicas: 2 }, { headers: key_headers }),
      scaling.delete(undefined, { headers: key_headers }),
    ]);

    for (const res of [saved, deleted]) {
      if (res.error) expect(res.error.status as number).toBe(409);
    }
    const final = (await read_scaling_config()) as { workflows: Record<string, ScalingPolicy> };
    expect([null, { ...POLICY, max_replicas: 2 }]).toContainEqual(final.workflows.app ?? null);
  });

  // A corrupt scaling:config is the controller's fault, reported as 502 like prompts.config_invalid.
  test('a corrupt config is 502 scaling.config_invalid on the policy routes', async () => {
    const { token, workflow_id } = await running_workflow('{oops');
    const headers = bearer(token);
    const scaling = api.workflows[workflow_id]!.scaling;

    const responses = await Promise.all([
      scaling.get({ $headers: headers }),
      scaling.put(POLICY, { headers: key_headers }),
      scaling.delete(undefined, { headers: key_headers }),
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
        scaling: { 'app.PriceAgent': POLICY, 'app.MetricsAgent': POLICY },
        reason:
          "the policy is keyed by agent name (app.PriceAgent, app.MetricsAgent); scaling.yaml now holds one policy for the whole workflow, so move one agent's fields up to the top level",
      },
      { scaling: {}, reason: 'min_replicas: Required' },
      { scaling: ['app.PriceAgent'], reason: 'Expected object, received array' },
    ];
    for (const { scaling, reason } of cases) {
      await reset_controller();
      const config = { workflows: { app: scaling }, owner: 'platform' };
      const { token, workflow_id } = await running_workflow(JSON.stringify(config));

      const res = await api.workflows[workflow_id]!.scaling.get({ $headers: bearer(token) });

      expect(res.error).toBeNull();
      expect(res.data).toEqual({ workflows: { app: { status: 'invalid', reason } } });
      expect(await read_scaling_config()).toEqual(config);
    }
  });

  test('deleting the policy clears it and keeps the other keys', async () => {
    const { token, workflow_id } = await running_workflow();
    const headers = bearer(token);

    const deleted = await api.workflows[workflow_id]!.scaling.delete(undefined, {
      headers: key_headers,
    });

    expect(deleted.error).toBeNull();
    expect(deleted.data).toEqual({ status: 'none' });
    expect(await read_scaling_config()).toEqual({ ...CONFIG, workflows: {} });
    const listed = await api.workflows[workflow_id]!.scaling.get({ $headers: headers });
    expect(listed.data).toEqual({ workflows: { app: { status: 'none' } } });
  });

  test('an invalid stored policy can be deleted', async () => {
    const { workflow_id } = await running_workflow(
      JSON.stringify({ workflows: { app: { ...POLICY, min_replicas: 0 } } })
    );

    const res = await api.workflows[workflow_id]!.scaling.delete(undefined, {
      headers: key_headers,
    });

    expect(res.error).toBeNull();
    expect(await read_scaling_config()).toEqual({ workflows: {} });
  });

  test('deleting when no policy is stored is 404 scaling.policy_not_found and creates nothing', async () => {
    const { workflow_id } = await running_workflow(null);

    const res = await api.workflows[workflow_id]!.scaling.delete(undefined, {
      headers: key_headers,
    });

    expect(res.error?.status as number).toBe(404);
    expect(error_code(res)).toBe('scaling.policy_not_found');
    expect(await read_scaling_config()).toBeNull();
  });

  // Each workflow of the workflow group has its own policy, keyed by its name.
  test('two workflows have independent policies: saving one leaves the other with none', async () => {
    const { token, workflow_id } = await running_workflow(null, [
      'app.Alpha',
      'app.Beta',
      'ops.Gamma',
    ]);
    const { workflow_id: ops_id } = await create_test_workflow({ name: 'ops' });
    await seed_workflows({ [workflow_id]: 'app', [ops_id]: 'ops' });

    const saved = await api.workflows[workflow_id]!.scaling.put(POLICY, { headers: key_headers });
    const listed = await api.workflows[workflow_id]!.scaling.get({ $headers: bearer(token) });
    const ops_listed = await api.workflows[ops_id]!.scaling.get({ $headers: bearer(token) });
    const deleted = await api.workflows[ops_id]!.scaling.delete(undefined, {
      headers: key_headers,
    });

    expect(saved.error).toBeNull();
    expect(listed.data).toEqual({ workflows: { app: { status: 'applied', policy: POLICY } } });
    expect(ops_listed.data).toEqual({ workflows: { ops: { status: 'none' } } });
    expect(deleted.error?.status as number).toBe(404);
    expect(error_code(deleted)).toBe('scaling.policy_not_found');
    expect(await read_scaling_config()).toEqual({ workflows: { app: POLICY } });
  });
});

describe('workflow scaling agents', () => {
  beforeEach(reset_controller);

  const SAMPLE = {
    replicas_running: 2,
    replicas_expected: 2,
    queue_length_total: 3,
    requests_per_minute_per_replica: 12.5,
    observed_at: 1_800_000_000.25,
  };

  test('lists the agents the policy applies to, in controller order, with their newest load', async () => {
    const { token, workflow_id } = await running_workflow();
    await seed_scaling_agents([
      { name: 'app.PriceAgent', replicas: 1, desired: 2, sample: SAMPLE },
      { name: 'app.IntentAgent', replicas: 1 },
      { name: 'app.StateDB', type: 'database' },
    ]);

    const res = await api.workflows[workflow_id]!.scaling.agents.get({ $headers: bearer(token) });

    expect(res.error).toBeNull();
    expect(res.data).toEqual({
      agents: [
        {
          name: 'app.PriceAgent',
          replicas_expected: 2,
          replicas_running: 2,
          load: {
            queue_length_total: 3,
            requests_per_minute_per_replica: 12.5,
            observed_at: '2027-01-15T08:00:00.250Z',
          },
        },
        { name: 'app.IntentAgent', replicas_expected: 1, replicas_running: 0, load: null },
      ],
    });
  });

  test('an agent with no desired count yet reports its configured replicas', async () => {
    const { token, workflow_id } = await running_workflow();
    await seed_scaling_agents([{ name: 'app.PriceAgent', replicas: 3 }]);

    const res = await api.workflows[workflow_id]!.scaling.agents.get({ $headers: bearer(token) });

    expect(res.data).toEqual({
      agents: [{ name: 'app.PriceAgent', replicas_expected: 3, replicas_running: 0, load: null }],
    });
  });

  test('a controller that has published no agents lists none', async () => {
    const { token, workflow_id } = await running_workflow(JSON.stringify(CONFIG), []);

    const res = await api.workflows[workflow_id]!.scaling.agents.get({ $headers: bearer(token) });

    expect(res.error).toBeNull();
    expect(res.data).toEqual({ agents: [] });
  });

  test('a corrupt spec hides that agent, a corrupt sample hides its load, a bad count falls back', async () => {
    const { token, workflow_id } = await running_workflow();
    await seed_scaling_agents([
      { name: 'app.PriceAgent', replicas: 1.5, desired: 2, sample: SAMPLE },
      { name: 'app.RiskAgent', replicas: 2, desired: 'two' as unknown as number },
      { name: 'app.IntentAgent', raw_spec: '{oops' },
      { name: 'app.MetricsAgent', raw_sample: '{oops' },
    ]);

    const res = await api.workflows[workflow_id]!.scaling.agents.get({ $headers: bearer(token) });

    expect(res.error).toBeNull();
    expect(res.data).toEqual({
      agents: [
        {
          name: 'app.PriceAgent',
          replicas_expected: 2,
          replicas_running: 2,
          load: expect.any(Object),
        },
        { name: 'app.RiskAgent', replicas_expected: 2, replicas_running: 0, load: null },
        { name: 'app.MetricsAgent', replicas_expected: 1, replicas_running: 0, load: null },
      ],
    });
  });

  test('a corrupt agents:active is 502 scaling.config_invalid on the agents read', async () => {
    const { token, workflow_id } = await running_workflow();
    await seed_scaling_agents([{ name: 'app.PriceAgent' }]);
    await seed_active_agents('{oops');

    const res = await api.workflows[workflow_id]!.scaling.agents.get({ $headers: bearer(token) });

    expect(res.error?.status as number).toBe(502);
    expect(error_code(res)).toBe('scaling.config_invalid');
  });

  test('a corrupt scaling config does not stop the agents from being listed', async () => {
    const { token, workflow_id } = await running_workflow('{oops');
    await seed_scaling_agents([{ name: 'app.PriceAgent' }]);

    const res = await api.workflows[workflow_id]!.scaling.agents.get({ $headers: bearer(token) });

    expect(res.error).toBeNull();
    expect(res.data?.agents.map((agent) => agent.name)).toEqual(['app.PriceAgent']);
  });
});
