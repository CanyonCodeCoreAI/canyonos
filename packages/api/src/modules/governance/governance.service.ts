// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { RedisClient } from 'bun';

import { unprocessable } from '@core/errors';

import { desired_replicas_key } from '../registry/registry.contract';
import { assert_workflow_running, with_redis } from '../registry/registry.redis';
import { read_agents } from '../scaling/scaling.service';
import { publish_spend } from './governance.publisher';
import { governance_repo } from './governance.repo';
import { REVIEW_TIMEOUT_DEFAULT_SECONDS } from './governance.types';
import type { AgentReading } from '../scaling/scaling.service';
import type { LlmEntry, StoredAgentRules } from './governance.repo';
import type {
  AgentRules,
  AgentSpend,
  AgentStatus,
  CostAction,
  GovernanceAgent,
  GovernanceResponse,
  ReviewRule,
  SavedAgentRules,
  SpendRule,
} from './governance.types';

function status_of(agent: AgentReading, up: ReadonlySet<string>): AgentStatus {
  if (agent.replicas_expected === 0) return 'stopped';
  if (agent.load === null) return 'unknown';
  return up.has(agent.name) ? 'up' : 'down';
}

/** The model ids of the llms.yaml entries open to every agent or naming this one. */
function models_for(llms: readonly LlmEntry[], agent: string): string[] {
  return llms
    .filter(({ agents }) => agents === null || agents.includes(agent))
    .map(({ model_id }) => model_id);
}

/** The rules as reported, with a review gate's timeout filled in as the Local Controllers fill it
 * when the stored rule leaves it out. */
function rules_of(stored: StoredAgentRules | undefined): SavedAgentRules {
  const review = stored?.review;
  return {
    requires: stored?.requires ?? [],
    spend: stored?.spend ?? null,
    review: review
      ? { ...review, timeout_seconds: review.timeout_seconds ?? REVIEW_TIMEOUT_DEFAULT_SECONDS }
      : null,
  };
}

/** The review gate to store: the body's, the stored one when the body leaves it out, and none
 * for null. */
function review_to_store(
  review: ReviewRule | null | undefined,
  stored: StoredAgentRules | undefined
): { review?: ReviewRule } {
  const kept = review === undefined ? stored?.review : review;
  return kept ? { review: kept } : {};
}

/** The action of the rule with the highest threshold below usd, or null when none is passed. */
function tripped_action(rules: readonly SpendRule[], usd: number): CostAction | null {
  const passed = rules.filter((rule) => rule.above_usd < usd);
  if (passed.length === 0) return null;
  return passed.reduce((highest, rule) => (rule.above_usd > highest.above_usd ? rule : highest))
    .action;
}

function spend_of(rules: SavedAgentRules, usd: number | undefined): AgentSpend | null {
  const since = rules.spend?.since;
  if (!rules.spend || since === undefined) return null;
  const total = usd ?? 0;
  return { since, usd: total, tripped_action: tripped_action(rules.spend.rules, total) };
}

async function read_governance(
  redis: RedisClient,
  workflow_id: string,
  workflow: string
): Promise<GovernanceResponse> {
  const [agents, config, up, llms, scaling_workflows] = await Promise.all([
    read_agents(redis, workflow),
    governance_repo.read_config(redis),
    governance_repo.read_up_agents(redis),
    governance_repo.read_llms(redis),
    governance_repo.scaling_workflows(redis),
  ]);
  const names = new Set(agents.map(({ name }) => name));
  const rules_by_name = new Map(agents.map(({ name }) => [name, rules_of(config.agents[name])]));
  const governed = [...rules_by_name].flatMap(([name, rules]) =>
    rules.spend?.since === undefined ? [] : [{ name, since: rules.spend.since }]
  );
  const [spend, edges] = await Promise.all([
    governance_repo.spend_since(workflow_id, governed),
    governance_repo.call_edges(workflow_id),
  ]);
  const status_by_name = new Map(agents.map((agent) => [agent.name, status_of(agent, up)]));

  return {
    agents: agents.map((agent): GovernanceAgent => {
      const rules = rules_by_name.get(agent.name)!;
      return {
        agent_id: Bun.randomUUIDv5(agent.name, workflow_id),
        name: agent.name,
        replicas_running: agent.replicas_running,
        replicas_expected: agent.replicas_configured,
        desired_replicas: agent.replicas_expected,
        status: status_by_name.get(agent.name)!,
        unmet_requires: rules.requires
          .filter((name) => status_by_name.get(name) !== 'up')
          .map((name) => Bun.randomUUIDv5(name, workflow_id)),
        models: llms === null ? null : models_for(llms, agent.name),
        // Rules are stored by agent name and answered by agent_id.
        rules: {
          ...rules,
          requires: rules.requires.map((name) => Bun.randomUUIDv5(name, workflow_id)),
        },
        spend: spend_of(rules, spend.get(agent.name)),
        // Agents are named `<workflow>.<agent>`; each workflow has its own policy.
        scaling_policy_present: scaling_workflows.has(agent.name.split('.')[0]!),
      };
    }),
    edges: edges
      .filter(({ source, target }) => names.has(source) && names.has(target))
      .map(({ source, target }) => ({
        source: Bun.randomUUIDv5(source, workflow_id),
        target: Bun.randomUUIDv5(target, workflow_id),
      })),
  };
}

function unknown_agent(agent_id: string) {
  return unprocessable(
    'governance.unknown_agent',
    `No agent of this workflow has the id ${agent_id}`
  );
}

/** The workflow's agents, by their agent_id. */
async function agents_by_id(
  redis: RedisClient,
  workflow: string,
  workflow_id: string
): Promise<Map<string, AgentReading>> {
  const agents = await read_agents(redis, workflow);
  return new Map(agents.map((agent) => [Bun.randomUUIDv5(agent.name, workflow_id), agent]));
}

export async function get_governance(workflow_id: string): Promise<GovernanceResponse> {
  return with_redis(workflow_id, async (redis) =>
    read_governance(redis, workflow_id, await assert_workflow_running(redis, workflow_id))
  );
}

/** Replaces one agent's rules, keeping its spend start unless the body moves it, and its review
 * gate unless the body names one or null. */
export async function save_agent_rules(
  workflow_id: string,
  agent_id: string,
  rules: AgentRules
): Promise<GovernanceResponse> {
  return with_redis(workflow_id, async (redis) => {
    const workflow = await assert_workflow_running(redis, workflow_id);
    const agents = await agents_by_id(redis, workflow, workflow_id);
    const missing = [agent_id, ...rules.requires].find((id) => !agents.has(id));
    if (missing !== undefined) throw unknown_agent(missing);
    const agent = agents.get(agent_id)!.name;
    const requires = rules.requires.map((required) => agents.get(required)!.name);

    const llms = await governance_repo.read_llms(redis);
    if (llms !== null) {
      const allowed = models_for(llms, agent);
      for (const { action } of rules.spend?.rules ?? []) {
        if (action.kind === 'switch_model' && !allowed.includes(action.model)) {
          throw unprocessable(
            'governance.model_not_allowed',
            `llms.yaml does not let ${agent} use ${action.model}`
          );
        }
      }
    }

    await governance_repo.write_agent_rules(redis, agent, (stored) => ({
      requires,
      spend: rules.spend && {
        ...rules.spend,
        since: rules.spend.since ?? stored?.spend?.since ?? new Date().toISOString(),
      },
      ...review_to_store(rules.review, stored),
    }));
    await publish_spend(redis, workflow_id);
    return read_governance(redis, workflow_id, workflow);
  });
}

/** Takes an agent out (0 desired replicas) or brings it back to its spec's count. */
export async function set_stopped(
  workflow_id: string,
  agent_id: string,
  stopped: boolean
): Promise<GovernanceResponse> {
  return with_redis(workflow_id, async (redis) => {
    const workflow = await assert_workflow_running(redis, workflow_id);
    const agent = (await agents_by_id(redis, workflow, workflow_id)).get(agent_id);
    if (!agent) throw unknown_agent(agent_id);
    await redis.set(
      desired_replicas_key(agent.name),
      String(stopped ? 0 : agent.replicas_configured)
    );
    return read_governance(redis, workflow_id, workflow);
  });
}
