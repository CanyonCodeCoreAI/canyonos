import { beforeEach, describe, expect, test } from 'bun:test';

import type { ScalingPolicy } from '@canyonos/api/scaling';

import { api, setupE2ETests } from './e2e.setup';
import { authenticate, bearer, create_test_project } from './project-test.utils';
import {
  read_scaling_config,
  reset_controller,
  seed_running_project,
  seed_scaling,
} from './redis-test.utils';

setupE2ETests();

const error_code = (res: { error: { value?: unknown } | null }) =>
  (res.error?.value as { error?: string } | undefined)?.error;

const AGENTS = ['MetricsAgent', 'PriceAgent', 'RiskAgent'];

const PRICE: ScalingPolicy = {
  min_replicas: 1,
  max_replicas: 6,
  metric: 'requests_per_minute_per_replica',
  scale_up_above: 10,
  scale_down_below: 1,
};

const METRICS: ScalingPolicy = {
  min_replicas: 1,
  max_replicas: 4,
  metric: 'queue_length_total',
  scale_up_above: 5,
  scale_down_below: 1,
};

// The GC publishes config/scaling.yaml as-is, so the document can carry keys besides `scaling`.
const CONFIG = { scaling: { PriceAgent: PRICE, MetricsAgent: METRICS }, owner: 'platform' };

async function running_project(
  email: string,
  scaling_config: string | null = JSON.stringify(CONFIG)
): Promise<{ token: string; project_id: string }> {
  const token = await authenticate(email);
  const { project_id } = await create_test_project(token, { name: 'Scaling Project' });
  await seed_running_project(project_id, { prompts: {} });
  await seed_scaling(AGENTS, scaling_config);
  return { token, project_id };
}

describe('project scaling policies', () => {
  beforeEach(reset_controller);

  test('lists the running agents and every stored policy', async () => {
    const { token, project_id } = await running_project('scaling-list@canyonos.test');

    const res = await api.projects[project_id]!.scaling.get({ $headers: bearer(token) });

    expect(res.error).toBeNull();
    expect(res.data).toEqual({
      agents: AGENTS,
      policies: { PriceAgent: PRICE, MetricsAgent: METRICS },
      invalid: [],
    });
  });

  test('saving a policy for a new agent keeps the other policies and keys', async () => {
    const { token, project_id } = await running_project('scaling-add@canyonos.test');
    const headers = bearer(token);
    const risk: ScalingPolicy = { ...METRICS, max_replicas: 2 };

    const saved = await api.projects[project_id]!.scaling.RiskAgent!.put(risk, { headers });

    expect(saved.error).toBeNull();
    expect(saved.data).toEqual(risk);
    expect(await read_scaling_config()).toEqual({
      ...CONFIG,
      scaling: { ...CONFIG.scaling, RiskAgent: risk },
    });
    const listed = await api.projects[project_id]!.scaling.get({ $headers: headers });
    expect(listed.data?.policies.RiskAgent).toEqual(risk);
  });

  test('saving over an existing policy replaces only that agent', async () => {
    const { token, project_id } = await running_project('scaling-replace@canyonos.test');
    const edited: ScalingPolicy = { ...PRICE, max_replicas: 3, scale_up_above: 20 };

    const saved = await api.projects[project_id]!.scaling.PriceAgent!.put(edited, {
      headers: bearer(token),
    });

    expect(saved.error).toBeNull();
    expect(await read_scaling_config()).toEqual({
      ...CONFIG,
      scaling: { PriceAgent: edited, MetricsAgent: METRICS },
    });
  });

  test('a controller with no scaling config lists no policies and the first save creates it', async () => {
    const { token, project_id } = await running_project('scaling-bare@canyonos.test', null);
    const headers = bearer(token);

    const listed = await api.projects[project_id]!.scaling.get({ $headers: headers });
    expect(listed.error).toBeNull();
    expect(listed.data).toEqual({ agents: AGENTS, policies: {}, invalid: [] });

    const saved = await api.projects[project_id]!.scaling.PriceAgent!.put(PRICE, { headers });
    expect(saved.error).toBeNull();
    expect(await read_scaling_config()).toEqual({ scaling: { PriceAgent: PRICE } });
  });

  test('saving for an agent the controller is not running is 404 scaling.agent_not_found', async () => {
    const { token, project_id } = await running_project('scaling-unknown@canyonos.test');

    const res = await api.projects[project_id]!.scaling.GhostAgent!.put(PRICE, {
      headers: bearer(token),
    });

    expect(res.error?.status as number).toBe(404);
    expect(error_code(res)).toBe('scaling.agent_not_found');
    expect(await read_scaling_config()).toEqual(CONFIG);
  });

  test('a project the controller is not running is 404 canyonos.project_not_running', async () => {
    const token = await authenticate('scaling-not-running@canyonos.test');
    const headers = bearer(token);
    const { project_id } = await create_test_project(token, { name: 'Idle Project' });
    const { project_id: running_id } = await create_test_project(token, { name: 'Running' });
    await seed_running_project(running_id, { prompts: {} });
    await seed_scaling(AGENTS, JSON.stringify(CONFIG));

    const listed = await api.projects[project_id]!.scaling.get({ $headers: headers });
    const saved = await api.projects[project_id]!.scaling.PriceAgent!.put(PRICE, { headers });

    for (const res of [listed, saved]) {
      expect(res.error?.status as number).toBe(404);
      expect(error_code(res)).toBe('canyonos.project_not_running');
    }
    expect(await read_scaling_config()).toEqual(CONFIG);
  });

  test('an invalid policy is 422 and nothing is stored', async () => {
    const { token, project_id } = await running_project('scaling-invalid@canyonos.test');
    const headers = bearer(token);
    const agent = api.projects[project_id]!.scaling.RiskAgent!;
    const invalid = [
      { ...PRICE, min_replicas: 5, max_replicas: 2 },
      { ...PRICE, scale_down_below: 10, scale_up_above: 10 },
      { ...PRICE, scale_down_below: 12, scale_up_above: 10 },
      { ...PRICE, min_replicas: -1 },
      { ...PRICE, min_replicas: 0 },
      { ...PRICE, min_replicas: 0, max_replicas: 0 },
      { ...PRICE, max_replicas: 2.5 },
      { ...PRICE, metric: 'cpu_percent' },
      { min_replicas: 1, max_replicas: 2, metric: 'queue_length_total', scale_up_above: 3 },
    ];

    const responses = await Promise.all(
      invalid.map((body) => agent.put(body as ScalingPolicy, { headers }))
    );

    for (const res of responses) {
      expect(res.error?.status as number).toBe(422);
    }
    expect(await read_scaling_config()).toEqual(CONFIG);
  });

  test('a caller with no token is rejected on both routes', async () => {
    const { project_id } = await running_project('scaling-anon@canyonos.test');

    const listed = await api.projects[project_id]!.scaling.get();
    const saved = await api.projects[project_id]!.scaling.PriceAgent!.put(PRICE);

    expect(listed.error?.status as number).toBe(401);
    expect(saved.error?.status as number).toBe(401);
    expect(await read_scaling_config()).toEqual(CONFIG);
  });

  test('a few operators saving different agents at once all land', async () => {
    const { token, project_id } = await running_project('scaling-race@canyonos.test', null);
    const headers = bearer(token);
    const policies = Object.fromEntries(
      AGENTS.map((agent_name, index) => [agent_name, { ...PRICE, max_replicas: index + 2 }])
    );

    const responses = await Promise.all(
      AGENTS.map((agent_name) =>
        api.projects[project_id]!.scaling[agent_name]!.put(policies[agent_name]!, { headers })
      )
    );

    for (const res of responses) {
      expect(res.error).toBeNull();
    }
    expect(await read_scaling_config()).toEqual({ scaling: policies });
  });

  // Without WATCH/MULTI a burst silently drops writes; with it every write lands or is told to retry.
  test('a burst of saves never loses one: each is stored or answered 409 scaling.save_conflict', async () => {
    const { token, project_id } = await running_project('scaling-burst@canyonos.test', null);
    const headers = bearer(token);
    const agents = Array.from({ length: 12 }, (_, index) => `Agent${index}`);
    await seed_scaling(agents, null);

    const responses = await Promise.all(
      agents.map((agent_name) =>
        api.projects[project_id]!.scaling[agent_name]!.put(PRICE, { headers })
      )
    );

    const stored = agents.filter((_, index) => responses[index]!.error === null);
    for (const res of responses.filter(({ error }) => error !== null)) {
      expect(res.error?.status as number).toBe(409);
      expect(error_code(res)).toBe('scaling.save_conflict');
    }
    expect(stored.length).toBeGreaterThan(0);
    expect(await read_scaling_config()).toEqual({
      scaling: Object.fromEntries(stored.map((agent_name) => [agent_name, PRICE])),
    });
  });

  // A corrupt scaling:config is the controller's fault, reported as 502 like prompts.config_invalid.
  test('a corrupt config is 502 scaling.config_invalid on every route', async () => {
    const { token, project_id } = await running_project(
      'scaling-corrupt-all@canyonos.test',
      '{oops'
    );
    const headers = bearer(token);
    const scaling = api.projects[project_id]!.scaling;

    const responses = await Promise.all([
      scaling.get({ $headers: headers }),
      scaling.PriceAgent!.put(PRICE, { headers }),
      scaling.PriceAgent!.delete(undefined, { headers }),
    ]);

    for (const res of responses) {
      expect(res.error?.status as number).toBe(502);
      expect(error_code(res)).toBe('scaling.config_invalid');
    }
  });

  test('a config whose scaling entry is not a mapping is 502 scaling.config_invalid', async () => {
    const { token, project_id } = await running_project(
      'scaling-not-mapping@canyonos.test',
      JSON.stringify({ scaling: ['PriceAgent'] })
    );

    const res = await api.projects[project_id]!.scaling.get({ $headers: bearer(token) });

    expect(res.error?.status as number).toBe(502);
    expect(error_code(res)).toBe('scaling.config_invalid');
  });

  // A hand-written scaling.yaml can hold policies the controller skips; the dashboard must say so.
  test('stored policies that fail validation are listed as invalid, not dropped', async () => {
    const config = {
      scaling: {
        PriceAgent: PRICE,
        MetricsAgent: { ...METRICS, min_replicas: 4, max_replicas: 2 },
        RiskAgent: { ...METRICS, min_replicas: 0 },
        GoneAgent: 'not a policy',
      },
    };
    const { token, project_id } = await running_project(
      'scaling-invalid-stored@canyonos.test',
      JSON.stringify(config)
    );

    const res = await api.projects[project_id]!.scaling.get({ $headers: bearer(token) });

    expect(res.error).toBeNull();
    expect(res.data).toEqual({
      agents: AGENTS,
      policies: { PriceAgent: PRICE },
      invalid: ['MetricsAgent', 'RiskAgent', 'GoneAgent'],
    });
    expect(await read_scaling_config()).toEqual(config);
  });

  test('deleting a policy removes only that agent and keeps the other keys', async () => {
    const { token, project_id } = await running_project('scaling-delete@canyonos.test');
    const headers = bearer(token);

    const deleted = await api.projects[project_id]!.scaling.PriceAgent!.delete(undefined, {
      headers,
    });

    expect(deleted.error).toBeNull();
    expect(deleted.data).toEqual({ agent_name: 'PriceAgent' });
    expect(await read_scaling_config()).toEqual({ ...CONFIG, scaling: { MetricsAgent: METRICS } });
    const listed = await api.projects[project_id]!.scaling.get({ $headers: headers });
    expect(listed.data?.policies).toEqual({ MetricsAgent: METRICS });
  });

  test('an invalid stored policy, or one for an agent no longer running, can be deleted', async () => {
    const config = {
      scaling: { GoneAgent: PRICE, MetricsAgent: { ...METRICS, min_replicas: 0 } },
    };
    const { token, project_id } = await running_project(
      'scaling-delete-stale@canyonos.test',
      JSON.stringify(config)
    );
    const headers = bearer(token);

    const gone = await api.projects[project_id]!.scaling.GoneAgent!.delete(undefined, { headers });
    const invalid = await api.projects[project_id]!.scaling.MetricsAgent!.delete(undefined, {
      headers,
    });

    expect(gone.error).toBeNull();
    expect(invalid.error).toBeNull();
    expect(await read_scaling_config()).toEqual({ scaling: {} });
  });

  test('deleting an agent with no stored policy is 404 scaling.policy_not_found', async () => {
    const { token, project_id } = await running_project('scaling-delete-missing@canyonos.test');

    const missing = await api.projects[project_id]!.scaling.RiskAgent!.delete(undefined, {
      headers: bearer(token),
    });

    expect(missing.error?.status as number).toBe(404);
    expect(error_code(missing)).toBe('scaling.policy_not_found');
    expect(await read_scaling_config()).toEqual(CONFIG);
  });

  test('deleting when the controller has no scaling config is 404 and creates nothing', async () => {
    const { token, project_id } = await running_project('scaling-delete-bare@canyonos.test', null);

    const res = await api.projects[project_id]!.scaling.RiskAgent!.delete(undefined, {
      headers: bearer(token),
    });

    expect(res.error?.status as number).toBe(404);
    expect(error_code(res)).toBe('scaling.policy_not_found');
    expect(await read_scaling_config()).toBeNull();
  });

  test('deleting on a project the controller is not running, or with no token, changes nothing', async () => {
    const token = await authenticate('scaling-delete-guard@canyonos.test');
    const { project_id } = await create_test_project(token, { name: 'Idle Project' });
    const { project_id: running_id } = await create_test_project(token, { name: 'Running' });
    await seed_running_project(running_id, { prompts: {} });
    await seed_scaling(AGENTS, JSON.stringify(CONFIG));

    const idle = await api.projects[project_id]!.scaling.PriceAgent!.delete(undefined, {
      headers: bearer(token),
    });
    const anon = await api.projects[running_id]!.scaling.PriceAgent!.delete();

    expect(idle.error?.status as number).toBe(404);
    expect(error_code(idle)).toBe('canyonos.project_not_running');
    expect(anon.error?.status as number).toBe(401);
    expect(await read_scaling_config()).toEqual(CONFIG);
  });

  test('concurrent deletes and saves for different agents all land', async () => {
    const { token, project_id } = await running_project('scaling-race-delete@canyonos.test', null);
    const headers = bearer(token);
    const kept = ['Agent0', 'Agent2'];
    const removed = ['Agent1', 'Agent3'];
    await seed_scaling(
      [...kept, ...removed],
      JSON.stringify({ scaling: Object.fromEntries(removed.map((name) => [name, PRICE])) })
    );

    const responses = await Promise.all([
      ...kept.map((name) => api.projects[project_id]!.scaling[name]!.put(METRICS, { headers })),
      ...removed.map((name) =>
        api.projects[project_id]!.scaling[name]!.delete(undefined, { headers })
      ),
    ]);

    for (const res of responses) {
      expect(res.error).toBeNull();
    }
    expect(await read_scaling_config()).toEqual({
      scaling: Object.fromEntries(kept.map((name) => [name, METRICS])),
    });
  });
});
