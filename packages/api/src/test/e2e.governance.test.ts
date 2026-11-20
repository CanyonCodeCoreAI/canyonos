// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { db } from '@api/db/client';
import { workflows } from '@api/db/schema';
import { config } from '@core/env';

import { publish_spend, PUBLISH_SPEND_FAILED } from '../modules/governance/governance.publisher';
import { for_each_registered_workflow } from '../modules/registry/registry.service';
import { group_workflow, setupE2ETests } from './e2e.setup';
import {
  read_desired_replicas,
  read_governance_config,
  read_governance_spend,
  reset_controller,
  seed_governance,
  seed_governance_spend,
  seed_llms,
  seed_running_workflow,
  seed_scaling,
  seed_scaling_agents,
  seed_up_agents,
} from './redis-test.utils';
import { write_workflow_span } from './telemetry-test.utils';
import { bearer, create_test_workflow, TEST_API_KEY } from './workflow-test.utils';
import type { AgentRules, GovernanceAgent } from '../modules/governance/governance.types';
import type { SeededAgent } from './redis-test.utils';

setupE2ETests();

const key_headers = bearer(TEST_API_KEY);

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

/** A running workflow whose agents are all up except TestRunnerAgent. */
async function governed_workflow(): Promise<{
  headers: Record<string, string>;
  workflow_id: string;
}> {
  const token = TEST_API_KEY;
  const { workflow_id } = await create_test_workflow({ name: 'Governance Workflow' });
  await seed_running_workflow(workflow_id, { prompts: {} });
  await seed_scaling_agents([...AGENTS.map((name) => sampled(name, 2)), { name: 'Idle' }]);
  await seed_up_agents(AGENTS.filter((name) => name !== 'TestRunnerAgent'));
  await seed_governance({ agents: { MergeAgent: { requires: ['TestRunnerAgent'] } } });
  return { headers: bearer(token), workflow_id };
}

const by_name = (agents: readonly GovernanceAgent[], name: string): GovernanceAgent => {
  const agent = agents.find((candidate) => candidate.name === name);
  if (!agent) throw new Error(`${name} is not in the response`);
  return agent;
};

const CLOSED_PORT = 1;

/** One round of the tick's spend job over every registered workflow. */
const publish_spend_once = () => for_each_registered_workflow(publish_spend, PUBLISH_SPEND_FAILED);

const register_at = (workflow_id: string, redis_port: number) =>
  db.update(workflows).set({ redis_port }).where(eq(workflows.id, workflow_id));

const SPEND_SINCE = '2026-09-01T00:00:00.000Z';

/** ReviewAgent spans worth 3 + 4 USD since SPEND_SINCE, plus spans that must not count. */
async function seed_review_spend(workflow_id: string, label: string): Promise<void> {
  const since_nanos = BigInt(Date.parse(SPEND_SINCE)) * 1_000_000n;
  const hour = 3_600_000_000_000n;
  await write_workflow_span(workflow_id, {
    span_id: `${label}-1`,
    name: 'ReviewAgent.review',
    cost: 3,
    start_time_unix_nano: since_nanos + hour,
  });
  await write_workflow_span(workflow_id, {
    span_id: `${label}-2`,
    name: 'ReviewAgent.review',
    cost: 4,
    start_time_unix_nano: since_nanos + 2n * hour,
  });
  await write_workflow_span(workflow_id, {
    span_id: `${label}-old`,
    name: 'ReviewAgent.review',
    cost: 10,
    start_time_unix_nano: since_nanos - hour,
  });
  await write_workflow_span(workflow_id, {
    span_id: `${label}-other`,
    name: 'MergeAgent.merge',
    cost: 100,
    start_time_unix_nano: since_nanos + hour,
  });
}

const MERGE_SPEND: NonNullable<AgentRules['spend']> = {
  rules: [{ above_usd: 5, action: { kind: 'switch_model', model: 'gpt-5.5-mini' } }],
};

describe('workflow governance', () => {
  beforeEach(reset_controller);

  test('reports each agent up, down, unknown or stopped and, by agent_id, the agents it requires and misses', async () => {
    const { headers, workflow_id } = await governed_workflow();
    await seed_scaling_agents([
      ...AGENTS.map((name) => sampled(name, 2)),
      { name: 'Idle' },
      { ...sampled('Parked'), desired: 0 },
    ]);

    const res = await group_workflow(workflow_id).governance.get({ $headers: headers });

    expect(res.error).toBeNull();
    const agents = res.data!.agents;
    expect(by_name(agents, 'Workflow').status).toBe('up');
    expect(by_name(agents, 'TestRunnerAgent').status).toBe('down');
    const runner_id = Bun.randomUUIDv5('TestRunnerAgent', workflow_id);
    expect(by_name(agents, 'MergeAgent')).toMatchObject({
      rules: { requires: [runner_id] },
      unmet_requires: [runner_id],
    });
    expect(by_name(agents, 'Workflow').unmet_requires).toEqual([]);
    expect(by_name(agents, 'Idle').status).toBe('unknown');
    expect(by_name(agents, 'Parked').status).toBe('stopped');
    expect(by_name(agents, 'Workflow')).toMatchObject({
      agent_id: Bun.randomUUIDv5('Workflow', workflow_id),
      replicas_running: 2,
      replicas_expected: 2,
      desired_replicas: 2,
      rules: { requires: [], spend: null },
      spend: null,
      scaling_policy_present: false,
    });
  });

  test('saving one agent rules stores them, requires by name, stamps since, and leaves the others alone', async () => {
    const { workflow_id } = await governed_workflow();
    await seed_governance({
      agents: {
        MergeAgent: { requires: ['TestRunnerAgent'] },
        Workflow: { requires: ['ReviewAgent'] },
      },
    });
    const merge_id = Bun.randomUUIDv5('MergeAgent', workflow_id);
    const merge = group_workflow(workflow_id).governance.agents[merge_id]!;
    const requires = [
      Bun.randomUUIDv5('TestRunnerAgent', workflow_id),
      Bun.randomUUIDv5('Workflow', workflow_id),
    ];

    const before = Date.now();
    const saved = await merge.put({ requires, spend: MERGE_SPEND }, { headers: key_headers });

    expect(saved.error).toBeNull();
    const stored = (await read_governance_config()) as {
      agents: Record<string, { requires: string[]; spend?: { since: string; rules: unknown[] } }>;
    };
    expect(stored.agents.Workflow).toEqual({ requires: ['ReviewAgent'] });
    expect(stored.agents.MergeAgent!.requires).toEqual(['TestRunnerAgent', 'Workflow']);
    expect(stored.agents.MergeAgent!.spend!.rules).toEqual(MERGE_SPEND.rules);
    const since = stored.agents.MergeAgent!.spend!.since;
    expect(Date.parse(since)).toBeGreaterThanOrEqual(before - 1000);
    expect(by_name(saved.data!.agents, 'MergeAgent').rules).toEqual({
      requires,
      spend: { since, rules: MERGE_SPEND.rules },
    });

    const raised: AgentRules = {
      requires: [],
      spend: { rules: [{ above_usd: 50, action: { kind: 'deny' } }] },
    };
    const again = await merge.put(raised, { headers: key_headers });

    expect(again.error).toBeNull();
    const restored = (await read_governance_config()) as typeof stored;
    expect(restored.agents.MergeAgent).toEqual({
      requires: [],
      spend: { since, rules: raised.spend!.rules },
    });
  });

  test('a required id of no agent, a model the agent may not use, an id of no agent or a name for an id is 422 and nothing is stored', async () => {
    const { workflow_id } = await governed_workflow();
    await seed_llms(LLMS);
    const agents = group_workflow(workflow_id).governance.agents;
    const merge = agents[Bun.randomUUIDv5('MergeAgent', workflow_id)]!;
    const ghost_id = Bun.randomUUIDv5('Ghost', workflow_id);

    const ghost = await merge.put({ requires: [ghost_id], spend: null }, { headers: key_headers });
    const forbidden = await merge.put(
      {
        requires: [],
        spend: { rules: [{ above_usd: 1, action: { kind: 'switch_model', model: 'gpt-5.5' } }] },
      },
      { headers: key_headers }
    );
    const unknown_agent = await agents[ghost_id]!.put(
      { requires: [], spend: null },
      { headers: key_headers }
    );
    const named = await agents.MergeAgent!.put(
      { requires: [], spend: null },
      { headers: key_headers }
    );

    expect(ghost.error?.status as number).toBe(422);
    expect(ghost.error?.value).toMatchObject({
      error: 'governance.unknown_agent',
      message: `No agent of this workflow has the id ${ghost_id}`,
    });
    expect(forbidden.error?.status as number).toBe(422);
    expect(error_code(forbidden)).toBe('governance.model_not_allowed');
    expect(unknown_agent.error?.status as number).toBe(422);
    expect(error_code(unknown_agent)).toBe('governance.unknown_agent');
    expect(named.error?.status as number).toBe(422);
    expect(error_code(named)).toBe('validation_error');
    expect(await read_governance_config()).toEqual({
      agents: { MergeAgent: { requires: ['TestRunnerAgent'] } },
    });
  });

  test('lists the models each agent may use and accepts one of them', async () => {
    const { headers, workflow_id } = await governed_workflow();
    await seed_llms(LLMS);
    const governance = group_workflow(workflow_id).governance;

    const listed = await governance.get({ $headers: headers });
    const saved = await governance.agents[Bun.randomUUIDv5('MergeAgent', workflow_id)]!.put(
      {
        requires: [],
        spend: {
          rules: [{ above_usd: 1, action: { kind: 'switch_model', model: 'claude-haiku' } }],
        },
      },
      { headers: key_headers }
    );

    expect([...by_name(listed.data!.agents, 'MergeAgent').models!].sort()).toEqual([
      'claude-haiku',
      'gpt-5.5-mini',
    ]);
    expect(by_name(listed.data!.agents, 'Workflow').models).toEqual(['claude-haiku']);
    expect(saved.error).toBeNull();
  });

  test('an llms.yaml entry without a model_id is skipped, as the gateway skips it', async () => {
    const { headers, workflow_id } = await governed_workflow();
    await seed_llms({ ...LLMS, unnamed: { agents: { MergeAgent: null } } });

    const listed = await group_workflow(workflow_id).governance.get({ $headers: headers });

    expect(listed.error).toBeNull();
    expect([...by_name(listed.data!.agents, 'MergeAgent').models!].sort()).toEqual([
      'claude-haiku',
      'gpt-5.5-mini',
    ]);
  });

  test('with no llms.yaml published any model is accepted and models is null', async () => {
    const { workflow_id } = await governed_workflow();
    const merge_id = Bun.randomUUIDv5('MergeAgent', workflow_id);

    const saved = await group_workflow(workflow_id).governance.agents[merge_id]!.put(
      {
        requires: [],
        spend: { rules: [{ above_usd: 1, action: { kind: 'switch_model', model: 'anything' } }] },
      },
      { headers: key_headers }
    );

    expect(saved.error).toBeNull();
    expect(by_name(saved.data!.agents, 'MergeAgent').models).toBeNull();
  });

  test('spend counts the agent cost since its start, names the highest rule passed and is published on save', async () => {
    const { workflow_id } = await governed_workflow();
    const since = SPEND_SINCE;
    await seed_review_spend(workflow_id, 'gov-spend');
    const review_id = Bun.randomUUIDv5('ReviewAgent', workflow_id);

    const saved = await group_workflow(workflow_id).governance.agents[review_id]!.put(
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
      { headers: key_headers }
    );

    expect(saved.error).toBeNull();
    expect(by_name(saved.data!.agents, 'ReviewAgent').spend).toEqual({
      since,
      usd: 7,
      tripped_action: { kind: 'switch_model', model: 'gpt-5.5-mini' },
    });
    expect(await read_governance_spend()).toEqual({ ReviewAgent: 7 });
  });

  test('edges are the distinct caller to callee agent_id pairs, never an agent calling itself', async () => {
    const { headers, workflow_id } = await governed_workflow();
    const now = BigInt(Date.now()) * 1_000_000n;
    const span = (span_id: string, name: string, parent_span_id?: string) =>
      write_workflow_span(workflow_id, {
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

    const res = await group_workflow(workflow_id).governance.get({ $headers: headers });

    expect(res.error).toBeNull();
    expect(res.data!.edges).toEqual([
      {
        source: Bun.randomUUIDv5('Workflow', workflow_id),
        target: Bun.randomUUIDv5('MergeAgent', workflow_id),
      },
    ]);
  });

  test('stopping an agent sets its desired replicas to 0 and starting it restores the spec count', async () => {
    const { workflow_id } = await governed_workflow();
    const runner_id = Bun.randomUUIDv5('TestRunnerAgent', workflow_id);
    const stopped = group_workflow(workflow_id).governance.agents[runner_id]!.stopped;

    const stop = await stopped.put({ stopped: true }, { headers: key_headers });

    expect(stop.error).toBeNull();
    expect(await read_desired_replicas('TestRunnerAgent')).toBe('0');
    expect(by_name(stop.data!.agents, 'TestRunnerAgent')).toMatchObject({
      status: 'stopped',
      desired_replicas: 0,
    });

    const start = await stopped.put({ stopped: false }, { headers: key_headers });

    expect(start.error).toBeNull();
    expect(await read_desired_replicas('TestRunnerAgent')).toBe('2');
    expect(by_name(start.data!.agents, 'TestRunnerAgent').status).toBe('down');
  });

  test('stopping an agent the controller does not run is 422 governance.unknown_agent', async () => {
    const { workflow_id } = await governed_workflow();
    const ghost_id = Bun.randomUUIDv5('Ghost', workflow_id);

    const res = await group_workflow(workflow_id).governance.agents[ghost_id]!.stopped.put(
      { stopped: true },
      { headers: key_headers }
    );

    expect(res.error?.status as number).toBe(422);
    expect(error_code(res)).toBe('governance.unknown_agent');
    expect(await read_desired_replicas('Ghost')).toBeNull();
  });

  test('reports whether a scaling policy is stored', async () => {
    const { headers, workflow_id } = await governed_workflow();
    await seed_scaling_agents([
      sampled('app.Workflow', 1),
      { ...sampled('ops.Workflow', 1), workflow: 'ops' },
    ]);
    await seed_scaling(JSON.stringify({ workflows: { app: { min_replicas: 1 } } }));

    const res = await group_workflow(workflow_id).governance.get({ $headers: headers });

    expect(by_name(res.data!.agents, 'app.Workflow').scaling_policy_present).toBe(true);
    // An agent of the workflow group's other workflow is that workflow's, not this one's.
    expect(res.data!.agents.map(({ name }) => name)).not.toContain('ops.Workflow');
  });

  test('a corrupt governance:config is 502 governance.config_invalid', async () => {
    const { headers, workflow_id } = await governed_workflow();
    await seed_governance({ agents: { MergeAgent: { requires: 'TestRunnerAgent' } } });

    const res = await group_workflow(workflow_id).governance.get({ $headers: headers });

    expect(res.error?.status as number).toBe(502);
    expect(error_code(res)).toBe('governance.config_invalid');
  });

  test('a workflow the controller is not running is 404 on every route', async () => {
    const token = TEST_API_KEY;
    const headers = bearer(token);
    const { workflow_id } = await create_test_workflow({ name: 'Idle Workflow' });
    const governance = group_workflow(workflow_id).governance;
    const merge = governance.agents[Bun.randomUUIDv5('MergeAgent', workflow_id)]!;

    const responses = await Promise.all([
      governance.get({ $headers: headers }),
      merge.put({ requires: [], spend: null }, { headers: key_headers }),
      merge.stopped.put({ stopped: true }, { headers: key_headers }),
    ]);

    for (const res of responses) {
      expect(res.error?.status as number).toBe(404);
      expect(error_code(res)).toBe('registry.workflow_not_running');
    }
  });

  test('a caller with no API key is rejected on every route', async () => {
    const { workflow_id } = await governed_workflow();
    const governance = group_workflow(workflow_id).governance;
    const merge = governance.agents[Bun.randomUUIDv5('MergeAgent', workflow_id)]!;

    const responses = await Promise.all([
      governance.get(),
      merge.put({ requires: [], spend: null }),
      merge.stopped.put({ stopped: true }),
    ]);

    for (const res of responses) {
      expect(res.error?.status as number).toBe(401);
    }
  });

  test('publishing writes each governed agent spend to its controller past a dead one', async () => {
    const { workflow_id } = await governed_workflow();
    await register_at(workflow_id, config.canyonos.redisPort);
    await seed_review_spend(workflow_id, 'gov-publish');
    await seed_governance({
      agents: {
        MergeAgent: { requires: ['TestRunnerAgent'] },
        ReviewAgent: {
          requires: [],
          spend: { since: SPEND_SINCE, rules: [{ above_usd: 5, action: { kind: 'deny' } }] },
        },
      },
    });
    const dead = await create_test_workflow({ name: 'Dead Controller' });
    await register_at(dead.workflow_id, CLOSED_PORT);

    await publish_spend_once();

    expect(await read_governance_spend()).toEqual({ ReviewAgent: 7 });
    // The round waits on every registered Redis, and one that never answers takes the 5 s
    // connection timeout.
  }, 15_000);

  test('publishing clears a stale governance:spend for a workflow without spend rules', async () => {
    const { workflow_id } = await governed_workflow();
    await register_at(workflow_id, config.canyonos.redisPort);
    await seed_governance_spend({ ReviewAgent: 7 });

    await publish_spend_once();

    expect(await read_governance_spend()).toEqual({});
    // The round waits on every registered Redis, and one that never answers takes the 5 s
    // connection timeout.
  }, 15_000);

  test("on Kubernetes spend goes to the Redis the operator lists for the workflow's group, not to the stored port", async () => {
    const { workflow_id } = await governed_workflow();
    // The port stored for it leads nowhere: on Kubernetes the Redis listed for its workflow group
    // (a test workflow is its own group) is used.
    await register_at(workflow_id, CLOSED_PORT);
    await seed_review_spend(workflow_id, 'gov-publish-k8s');
    await seed_governance({
      agents: {
        ReviewAgent: {
          requires: [],
          spend: { since: SPEND_SINCE, rules: [{ above_usd: 5, action: { kind: 'deny' } }] },
        },
      },
    });
    // Stored, but its workflow group is no longer listed: gone from the cluster, so it is skipped.
    const gone = await create_test_workflow({ name: 'Gone From The Cluster' });
    await register_at(gone.workflow_id, CLOSED_PORT);

    const dir = mkdtempSync(join(tmpdir(), 'registry-'));
    const path = join(dir, 'projects.json');
    const redis = { host: config.canyonos.redisHost, port: config.canyonos.redisPort };
    writeFileSync(
      path,
      JSON.stringify({
        projects: [{ project_id: workflow_id, name: 'governed', redis }],
      })
    );
    const docker = config.canyonos.workflowsFile;
    config.canyonos.workflowsFile = path;
    try {
      await publish_spend_once();
    } finally {
      config.canyonos.workflowsFile = docker;
      rmSync(dir, { recursive: true, force: true });
    }

    expect(await read_governance_spend()).toEqual({ ReviewAgent: 7 });
  });
});
