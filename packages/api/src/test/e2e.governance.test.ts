// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { db } from '@api/db/client';
import { projects } from '@api/db/schema';
import { config } from '@core/env';

import { publish_spend_once } from '../modules/governance/governance.publisher';
import { api, setupE2ETests } from './e2e.setup';
import { authenticate, bearer, create_test_project } from './project-test.utils';
import {
  read_desired_replicas,
  read_governance_config,
  read_governance_spend,
  reset_controller,
  seed_governance,
  seed_governance_spend,
  seed_llms,
  seed_running_project,
  seed_scaling,
  seed_scaling_agents,
  seed_up_agents,
} from './redis-test.utils';
import { write_project_span } from './telemetry-test.utils';
import type { AgentRules, GovernanceAgent } from '../modules/governance/governance.types';
import type { SeededAgent } from './redis-test.utils';

setupE2ETests();

const error_code = (res: { error: { value?: unknown } | null }) =>
  (res.error?.value as { error?: string } | undefined)?.error;

const now_seconds = () => Date.now() / 1000;

const sampled = (name: string, replicas = 1): SeededAgent => ({
  name,
  replicas,
  sample: {
    replicas_running: replicas,
    replicas_expected: replicas,
    queue_length_total: 0,
    requests_per_minute_per_replica: 0,
    observed_at: now_seconds(),
  },
});

const AGENTS = ['Workflow', 'TestRunnerAgent', 'MergeAgent', 'ReviewAgent'];

const LLMS = {
  fast: { model_id: 'gpt-5.5-mini', agents: { MergeAgent: null } },
  strong: { model_id: 'gpt-5.5', agents: { ReviewAgent: 0.5 } },
  open: { model_id: 'claude-haiku' },
};

/** A running project whose agents are all up except TestRunnerAgent. */
async function governed_project(
  email: string
): Promise<{ headers: Record<string, string>; project_id: string }> {
  const token = await authenticate(email);
  const { project_id } = await create_test_project(token, { name: 'Governance Project' });
  await seed_running_project(project_id, { prompts: {} });
  await seed_scaling_agents([...AGENTS.map((name) => sampled(name, 2)), { name: 'Idle' }]);
  await seed_up_agents(AGENTS.filter((name) => name !== 'TestRunnerAgent'));
  await seed_governance({ agents: { MergeAgent: { requires: ['TestRunnerAgent'] } } });
  return { headers: bearer(token), project_id };
}

const by_name = (agents: readonly GovernanceAgent[], name: string): GovernanceAgent => {
  const agent = agents.find((candidate) => candidate.name === name);
  if (!agent) throw new Error(`${name} is not in the response`);
  return agent;
};

const CLOSED_PORT = 1;

const register_at = (project_id: string, redis_port: number) =>
  db.update(projects).set({ redis_port }).where(eq(projects.id, project_id));

const SPEND_SINCE = '2026-09-01T00:00:00.000Z';

/** ReviewAgent spans worth 3 + 4 USD since SPEND_SINCE, plus spans that must not count. */
async function seed_review_spend(project_id: string, label: string): Promise<void> {
  const since_nanos = BigInt(Date.parse(SPEND_SINCE)) * 1_000_000n;
  const hour = 3_600_000_000_000n;
  await write_project_span(project_id, {
    span_id: `${label}-1`,
    name: 'ReviewAgent.review',
    cost: 3,
    start_time_unix_nano: since_nanos + hour,
  });
  await write_project_span(project_id, {
    span_id: `${label}-2`,
    name: 'ReviewAgent.review',
    cost: 4,
    start_time_unix_nano: since_nanos + 2n * hour,
  });
  await write_project_span(project_id, {
    span_id: `${label}-old`,
    name: 'ReviewAgent.review',
    cost: 10,
    start_time_unix_nano: since_nanos - hour,
  });
  await write_project_span(project_id, {
    span_id: `${label}-other`,
    name: 'MergeAgent.merge',
    cost: 100,
    start_time_unix_nano: since_nanos + hour,
  });
}

const MERGE_RULES: AgentRules = {
  requires: ['TestRunnerAgent', 'Workflow'],
  spend: { rules: [{ above_usd: 5, action: { kind: 'switch_model', model: 'gpt-5.5-mini' } }] },
};

describe('project governance', () => {
  beforeEach(reset_controller);

  test('reports each agent up, down, unknown or stopped and the requirements it misses', async () => {
    const { headers, project_id } = await governed_project('gov-state@canyonos.test');
    await seed_scaling_agents([
      ...AGENTS.map((name) => sampled(name, 2)),
      { name: 'Idle' },
      { ...sampled('Parked'), desired: 0 },
    ]);

    const res = await api.projects[project_id]!.governance.get({ $headers: headers });

    expect(res.error).toBeNull();
    const agents = res.data!.agents;
    expect(by_name(agents, 'Workflow').status).toBe('up');
    expect(by_name(agents, 'TestRunnerAgent').status).toBe('down');
    expect(by_name(agents, 'MergeAgent').unmet_requires).toEqual(['TestRunnerAgent']);
    expect(by_name(agents, 'Workflow').unmet_requires).toEqual([]);
    expect(by_name(agents, 'Idle').status).toBe('unknown');
    expect(by_name(agents, 'Parked').status).toBe('stopped');
    expect(by_name(agents, 'Workflow')).toMatchObject({
      replicas_running: 2,
      replicas_expected: 2,
      desired_replicas: 2,
      rules: { requires: [], spend: null },
      spend: null,
      scaling_policy_present: false,
    });
  });

  test('saving one agent rules stores them, stamps since, and leaves the others alone', async () => {
    const { headers, project_id } = await governed_project('gov-save@canyonos.test');
    await seed_governance({
      agents: {
        MergeAgent: { requires: ['TestRunnerAgent'] },
        Workflow: { requires: ['ReviewAgent'] },
      },
    });
    const governance = api.projects[project_id]!.governance;

    const before = Date.now();
    const saved = await governance.agents.MergeAgent!.put(MERGE_RULES, { headers });

    expect(saved.error).toBeNull();
    const stored = (await read_governance_config()) as {
      agents: Record<string, { requires: string[]; spend?: { since: string; rules: unknown[] } }>;
    };
    expect(stored.agents.Workflow).toEqual({ requires: ['ReviewAgent'] });
    expect(stored.agents.MergeAgent!.requires).toEqual(['TestRunnerAgent', 'Workflow']);
    expect(stored.agents.MergeAgent!.spend!.rules).toEqual(MERGE_RULES.spend!.rules);
    const since = stored.agents.MergeAgent!.spend!.since;
    expect(Date.parse(since)).toBeGreaterThanOrEqual(before - 1000);
    expect(by_name(saved.data!.agents, 'MergeAgent').rules.spend?.since).toBe(since);

    const raised: AgentRules = {
      requires: [],
      spend: { rules: [{ above_usd: 50, action: { kind: 'deny' } }] },
    };
    const again = await governance.agents.MergeAgent!.put(raised, { headers });

    expect(again.error).toBeNull();
    const restored = (await read_governance_config()) as typeof stored;
    expect(restored.agents.MergeAgent).toEqual({
      requires: [],
      spend: { since, rules: raised.spend!.rules },
    });
  });

  test('an unknown required agent or a model the agent may not use is 422 and nothing is stored', async () => {
    const { headers, project_id } = await governed_project('gov-invalid@canyonos.test');
    await seed_llms(LLMS);
    const merge = api.projects[project_id]!.governance.agents.MergeAgent!;

    const ghost = await merge.put({ requires: ['Ghost'], spend: null }, { headers });
    const forbidden = await merge.put(
      {
        requires: [],
        spend: { rules: [{ above_usd: 1, action: { kind: 'switch_model', model: 'gpt-5.5' } }] },
      },
      { headers }
    );
    const unknown_agent = await api.projects[project_id]!.governance.agents.Ghost!.put(
      { requires: [], spend: null },
      { headers }
    );

    expect(ghost.error?.status as number).toBe(422);
    expect(error_code(ghost)).toBe('governance.unknown_agent');
    expect(forbidden.error?.status as number).toBe(422);
    expect(error_code(forbidden)).toBe('governance.model_not_allowed');
    expect(unknown_agent.error?.status as number).toBe(422);
    expect(error_code(unknown_agent)).toBe('governance.unknown_agent');
    expect(await read_governance_config()).toEqual({
      agents: { MergeAgent: { requires: ['TestRunnerAgent'] } },
    });
  });

  test('lists the models each agent may use and accepts one of them', async () => {
    const { headers, project_id } = await governed_project('gov-models@canyonos.test');
    await seed_llms(LLMS);
    const governance = api.projects[project_id]!.governance;

    const listed = await governance.get({ $headers: headers });
    const saved = await governance.agents.MergeAgent!.put(
      {
        requires: [],
        spend: {
          rules: [{ above_usd: 1, action: { kind: 'switch_model', model: 'claude-haiku' } }],
        },
      },
      { headers }
    );

    expect([...by_name(listed.data!.agents, 'MergeAgent').models!].sort()).toEqual([
      'claude-haiku',
      'gpt-5.5-mini',
    ]);
    expect(by_name(listed.data!.agents, 'Workflow').models).toEqual(['claude-haiku']);
    expect(saved.error).toBeNull();
  });

  test('an llms.yaml entry without a model_id is skipped, as the gateway skips it', async () => {
    const { headers, project_id } = await governed_project('gov-llms-no-model@canyonos.test');
    await seed_llms({ ...LLMS, unnamed: { agents: { MergeAgent: null } } });

    const listed = await api.projects[project_id]!.governance.get({ $headers: headers });

    expect(listed.error).toBeNull();
    expect([...by_name(listed.data!.agents, 'MergeAgent').models!].sort()).toEqual([
      'claude-haiku',
      'gpt-5.5-mini',
    ]);
  });

  test('with no llms.yaml published any model is accepted and models is null', async () => {
    const { headers, project_id } = await governed_project('gov-no-llms@canyonos.test');

    const saved = await api.projects[project_id]!.governance.agents.MergeAgent!.put(
      {
        requires: [],
        spend: { rules: [{ above_usd: 1, action: { kind: 'switch_model', model: 'anything' } }] },
      },
      { headers }
    );

    expect(saved.error).toBeNull();
    expect(by_name(saved.data!.agents, 'MergeAgent').models).toBeNull();
  });

  test('spend counts the agent cost since its start, names the highest rule passed and is published on save', async () => {
    const { headers, project_id } = await governed_project('gov-spend@canyonos.test');
    const since = SPEND_SINCE;
    await seed_review_spend(project_id, 'gov-spend');

    const saved = await api.projects[project_id]!.governance.agents.ReviewAgent!.put(
      {
        requires: [],
        spend: {
          since,
          rules: [
            { above_usd: 5, action: { kind: 'switch_model', model: 'gpt-5.5-mini' } },
            { above_usd: 20, action: { kind: 'deny' } },
          ],
        },
      },
      { headers }
    );

    expect(saved.error).toBeNull();
    expect(by_name(saved.data!.agents, 'ReviewAgent').spend).toEqual({
      since,
      usd: 7,
      tripped_action: { kind: 'switch_model', model: 'gpt-5.5-mini' },
    });
    expect(await read_governance_spend()).toEqual({ ReviewAgent: 7 });
  });

  test('edges are the distinct caller to callee agent pairs, never an agent calling itself', async () => {
    const { headers, project_id } = await governed_project('gov-edges@canyonos.test');
    const now = BigInt(Date.now()) * 1_000_000n;
    const span = (span_id: string, name: string, parent_span_id?: string) =>
      write_project_span(project_id, {
        span_id,
        trace_id: 'gov-edges',
        name,
        parent_span_id,
        start_time_unix_nano: now - 1_000_000_000n,
      });
    await span('gov-edge-root', 'Workflow.review');
    await span('gov-edge-merge', 'MergeAgent.merge', 'gov-edge-root');
    await span('gov-edge-merge-2', 'MergeAgent.merge', 'gov-edge-root');
    await span('gov-edge-self', 'Workflow.helper', 'gov-edge-root');
    await span('gov-edge-ghost', 'Ghost.run', 'gov-edge-root');

    const res = await api.projects[project_id]!.governance.get({ $headers: headers });

    expect(res.error).toBeNull();
    expect(res.data!.edges).toEqual([{ source: 'Workflow', target: 'MergeAgent' }]);
  });

  test('stopping an agent sets its desired replicas to 0 and starting it restores the spec count', async () => {
    const { headers, project_id } = await governed_project('gov-stop@canyonos.test');
    const stopped = api.projects[project_id]!.governance.agents.TestRunnerAgent!.stopped;

    const stop = await stopped.put({ stopped: true }, { headers });

    expect(stop.error).toBeNull();
    expect(await read_desired_replicas('TestRunnerAgent')).toBe('0');
    expect(by_name(stop.data!.agents, 'TestRunnerAgent')).toMatchObject({
      status: 'stopped',
      desired_replicas: 0,
    });

    const start = await stopped.put({ stopped: false }, { headers });

    expect(start.error).toBeNull();
    expect(await read_desired_replicas('TestRunnerAgent')).toBe('2');
    expect(by_name(start.data!.agents, 'TestRunnerAgent').status).toBe('down');
  });

  test('stopping an agent the controller does not run is 422 governance.unknown_agent', async () => {
    const { headers, project_id } = await governed_project('gov-stop-ghost@canyonos.test');

    const res = await api.projects[project_id]!.governance.agents.Ghost!.stopped.put(
      { stopped: true },
      { headers }
    );

    expect(res.error?.status as number).toBe(422);
    expect(error_code(res)).toBe('governance.unknown_agent');
    expect(await read_desired_replicas('Ghost')).toBeNull();
  });

  test('reports whether a scaling policy is stored', async () => {
    const { headers, project_id } = await governed_project('gov-scaling@canyonos.test');
    await seed_scaling(JSON.stringify({ scaling: { min_replicas: 1 } }));

    const res = await api.projects[project_id]!.governance.get({ $headers: headers });

    expect(by_name(res.data!.agents, 'Workflow').scaling_policy_present).toBe(true);
  });

  test('a corrupt governance:config is 502 governance.config_invalid', async () => {
    const { headers, project_id } = await governed_project('gov-corrupt@canyonos.test');
    await seed_governance({ agents: { MergeAgent: { requires: 'TestRunnerAgent' } } });

    const res = await api.projects[project_id]!.governance.get({ $headers: headers });

    expect(res.error?.status as number).toBe(502);
    expect(error_code(res)).toBe('governance.config_invalid');
  });

  test('a project the controller is not running is 404 on every route', async () => {
    const token = await authenticate('gov-not-running@canyonos.test');
    const headers = bearer(token);
    const { project_id } = await create_test_project(token, { name: 'Idle Project' });
    const governance = api.projects[project_id]!.governance;

    const responses = await Promise.all([
      governance.get({ $headers: headers }),
      governance.agents.MergeAgent!.put({ requires: [], spend: null }, { headers }),
      governance.agents.MergeAgent!.stopped.put({ stopped: true }, { headers }),
    ]);

    for (const res of responses) {
      expect(res.error?.status as number).toBe(404);
      expect(error_code(res)).toBe('canyonos.project_not_running');
    }
  });

  test('a caller with no token is rejected on every route', async () => {
    const { project_id } = await governed_project('gov-anon@canyonos.test');
    const governance = api.projects[project_id]!.governance;

    const responses = await Promise.all([
      governance.get(),
      governance.agents.MergeAgent!.put({ requires: [], spend: null }),
      governance.agents.MergeAgent!.stopped.put({ stopped: true }),
    ]);

    for (const res of responses) {
      expect(res.error?.status as number).toBe(401);
    }
  });

  test('publishing writes each governed agent spend to its controller past a dead one', async () => {
    const { project_id } = await governed_project('gov-publish@canyonos.test');
    await register_at(project_id, config.canyonos.redisPort);
    await seed_review_spend(project_id, 'gov-publish');
    await seed_governance({
      agents: {
        MergeAgent: { requires: ['TestRunnerAgent'] },
        ReviewAgent: {
          requires: [],
          spend: { since: SPEND_SINCE, rules: [{ above_usd: 5, action: { kind: 'deny' } }] },
        },
      },
    });
    const token = await authenticate('gov-publish-dead@canyonos.test');
    const dead = await create_test_project(token, { name: 'Dead Controller' });
    await register_at(dead.project_id, CLOSED_PORT);

    await publish_spend_once();

    expect(await read_governance_spend()).toEqual({ ReviewAgent: 7 });
  });

  test('publishing clears a stale governance:spend for a project without spend rules', async () => {
    const { project_id } = await governed_project('gov-publish-none@canyonos.test');
    await register_at(project_id, config.canyonos.redisPort);
    await seed_governance_spend({ ReviewAgent: 7 });

    await publish_spend_once();

    expect(await read_governance_spend()).toEqual({});
  });
});
