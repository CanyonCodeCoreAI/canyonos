// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { RedisClient } from 'bun';

import { unprocessable } from '@core/errors';

import { assert_project_running, with_redis } from '../canyonos/canyonos.redis';
import { read_agents } from '../scaling/scaling.service';
import { publish_spend } from './governance.publisher';
import { governance_repo } from './governance.repo';
import type { AgentReading } from '../scaling/scaling.service';
import type { LlmEntry, StoredAgentRules } from './governance.repo';
import type {
  AgentRules,
  AgentSpend,
  AgentStatus,
  CostAction,
  GovernanceAgent,
  GovernanceResponse,
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

function rules_of(stored: StoredAgentRules | undefined): AgentRules {
  return { requires: stored?.requires ?? [], spend: stored?.spend ?? null };
}

/** The action of the rule with the highest threshold below usd, or null when none is passed. */
function tripped_action(rules: readonly SpendRule[], usd: number): CostAction | null {
  const passed = rules.filter((rule) => rule.above_usd < usd);
  if (passed.length === 0) return null;
  return passed.reduce((highest, rule) => (rule.above_usd > highest.above_usd ? rule : highest))
    .action;
}

function spend_of(rules: AgentRules, usd: number | undefined): AgentSpend | null {
  const since = rules.spend?.since;
  if (!rules.spend || since === undefined) return null;
  const total = usd ?? 0;
  return { since, usd: total, tripped_action: tripped_action(rules.spend.rules, total) };
}

async function read_governance(
  redis: RedisClient,
  project_id: string
): Promise<GovernanceResponse> {
  const [agents, config, up, llms, scaling_policy_present] = await Promise.all([
    read_agents(redis),
    governance_repo.read_config(redis),
    governance_repo.read_up_agents(redis),
    governance_repo.read_llms(redis),
    governance_repo.scaling_policy_present(redis),
  ]);
  const names = new Set(agents.map(({ name }) => name));
  const rules_by_name = new Map(agents.map(({ name }) => [name, rules_of(config.agents[name])]));
  const governed = [...rules_by_name].flatMap(([name, rules]) =>
    rules.spend?.since === undefined ? [] : [{ name, since: rules.spend.since }]
  );
  const [spend, edges] = await Promise.all([
    governance_repo.spend_since(project_id, governed),
    governance_repo.call_edges(project_id),
  ]);
  const status_by_name = new Map(agents.map((agent) => [agent.name, status_of(agent, up)]));

  return {
    agents: agents.map((agent): GovernanceAgent => {
      const rules = rules_by_name.get(agent.name)!;
      return {
        name: agent.name,
        replicas_running: agent.replicas_running,
        replicas_expected: agent.replicas_configured,
        desired_replicas: agent.replicas_expected,
        status: status_by_name.get(agent.name)!,
        unmet_requires: rules.requires.filter((name) => status_by_name.get(name) !== 'up'),
        models: llms === null ? null : models_for(llms, agent.name),
        rules,
        spend: spend_of(rules, spend.get(agent.name)),
        scaling_policy_present,
      };
    }),
    edges: edges.filter(({ source, target }) => names.has(source) && names.has(target)),
  };
}

function unknown_agent(name: string) {
  return unprocessable(
    'governance.unknown_agent',
    `${name} is not an agent of the running project`
  );
}

async function find_agent(redis: RedisClient, name: string): Promise<AgentReading[]> {
  const agents = await read_agents(redis);
  if (!agents.some((agent) => agent.name === name)) throw unknown_agent(name);
  return agents;
}

export async function get_governance(project_id: string): Promise<GovernanceResponse> {
  return with_redis(project_id, async (redis) => {
    await assert_project_running(redis, project_id);
    return read_governance(redis, project_id);
  });
}

/** Replaces one agent's rules, keeping its spend start unless the body moves it. */
export async function save_agent_rules(
  project_id: string,
  agent: string,
  rules: AgentRules
): Promise<GovernanceResponse> {
  return with_redis(project_id, async (redis) => {
    await assert_project_running(redis, project_id);
    const agents = await find_agent(redis, agent);
    const names = new Set(agents.map(({ name }) => name));
    const missing = rules.requires.find((name) => !names.has(name));
    if (missing !== undefined) throw unknown_agent(missing);

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

    await governance_repo.write_agent_rules(redis, agent, (stored) => {
      if (rules.spend === null) return rules;
      const since = rules.spend.since ?? stored?.spend?.since ?? new Date().toISOString();
      return { ...rules, spend: { ...rules.spend, since } };
    });
    await publish_spend(redis, project_id);
    return read_governance(redis, project_id);
  });
}

/** Takes an agent out (0 desired replicas) or brings it back to its spec's count. */
export async function set_stopped(
  project_id: string,
  agent: string,
  stopped: boolean
): Promise<GovernanceResponse> {
  return with_redis(project_id, async (redis) => {
    await assert_project_running(redis, project_id);
    const agents = await find_agent(redis, agent);
    const { replicas_configured } = agents.find(({ name }) => name === agent)!;
    await redis.set(`agent:${agent}:desired_replicas`, String(stopped ? 0 : replicas_configured));
    return read_governance(redis, project_id);
  });
}
