// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { RedisClient } from 'bun';

import { db } from '@api/db/client';
import { badGateway, conflict } from '@core/errors';
import { parse_json } from '@core/json';
import { update_json_key } from '@core/redis';

import { spanAgentName, spanCost, workflowGroupSpans, workflowSpans } from '../metrics/metrics.sql';
import {
  GOVERNANCE_CONFIG_KEY,
  GOVERNANCE_SPEND_KEY,
  LLMS_CONFIG_KEY,
  SCALING_CONFIG_KEY,
  UP_AGENTS_KEY,
} from '../registry/registry.contract';
import { SpendRuleSchema } from './governance.types';
import type { AgentRules } from './governance.types';

const EDGE_DAYS = 7;
const DAY_MS = 86_400_000;

// As stored, `requires` and `spend` may be absent, and `since` too until a writer stamps it.
const StoredAgentRulesSchema = z.object({
  requires: z.array(z.string()).optional(),
  spend: z
    .object({ since: z.string().datetime().optional(), rules: z.array(SpendRuleSchema) })
    .nullable()
    .optional(),
});

// Other top-level keys are kept untouched on save.
const GovernanceConfigSchema = z
  .object({ agents: z.record(z.string(), StoredAgentRulesSchema).default({}) })
  .passthrough();

export type StoredAgentRules = z.infer<typeof StoredAgentRulesSchema>;
export type GovernanceConfig = z.infer<typeof GovernanceConfigSchema>;

// llms.yaml as published: label to entry; an entry without `agents` is open to every agent.
// An entry without `model_id` is skipped, as the gateway skips it.
const LlmsSchema = z.record(
  z.string(),
  z.object({ model_id: z.string().nullish(), agents: z.record(z.string(), z.unknown()).nullish() })
);

/** One llms.yaml entry: its model id and the agents allowed it, or null when open to all. */
export interface LlmEntry {
  readonly model_id: string;
  readonly agents: readonly string[] | null;
}

function config_invalid(key: string, reason: string, cause?: unknown) {
  return badGateway('governance.config_invalid', `The running controller's ${key} ${reason}`, {
    cause,
  });
}

function parse_config(raw: string | null): GovernanceConfig {
  const document = parse_json(raw ?? '{}');
  if (document === undefined) throw config_invalid(GOVERNANCE_CONFIG_KEY, 'is not valid JSON');
  const result = GovernanceConfigSchema.safeParse(document);
  if (!result.success) {
    throw config_invalid(GOVERNANCE_CONFIG_KEY, 'is not a governance document', result.error);
  }
  return result.data;
}

export const governance_repo = {
  async read_config(redis: RedisClient): Promise<GovernanceConfig> {
    return parse_config(await redis.get(GOVERNANCE_CONFIG_KEY));
  },

  /** The gateway reads this every few seconds; one SET so it never sees a partial document. */
  async write_spend(redis: RedisClient, spend: ReadonlyMap<string, number>): Promise<void> {
    await redis.set(GOVERNANCE_SPEND_KEY, JSON.stringify(Object.fromEntries(spend)));
  },

  /** Replaces one agent's entry, retrying while another writer races us. */
  async write_agent_rules(
    redis: RedisClient,
    agent: string,
    rules: (stored: StoredAgentRules | undefined) => AgentRules
  ): Promise<void> {
    const saved = await update_json_key(redis, GOVERNANCE_CONFIG_KEY, (raw) => {
      const config = parse_config(raw);
      return { ...config, agents: { ...config.agents, [agent]: rules(config.agents[agent]) } };
    });
    if (saved) return;
    throw conflict(
      'governance.save_conflict',
      'The governance rules kept changing while they were being saved, try again'
    );
  },

  /** Null when no llms.yaml is published, so no model is restricted. */
  async read_llms(redis: RedisClient): Promise<LlmEntry[] | null> {
    const raw = await redis.get(LLMS_CONFIG_KEY);
    if (raw === null) return null;
    const result = LlmsSchema.safeParse(parse_json(raw));
    if (!result.success)
      throw config_invalid(LLMS_CONFIG_KEY, 'is not an llms.yaml document', result.error);
    return Object.values(result.data).flatMap(({ model_id, agents }) =>
      model_id ? [{ model_id, agents: agents == null ? null : Object.keys(agents) }] : []
    );
  },

  /** The workflows with a scaling policy stored, from `{workflows: {<workflow>: <policy>}}`. */
  async scaling_workflows(redis: RedisClient): Promise<Set<string>> {
    const document = parse_json(await redis.get(SCALING_CONFIG_KEY));
    const workflows =
      typeof document === 'object' && document !== null && 'workflows' in document
        ? document.workflows
        : null;
    if (typeof workflows !== 'object' || workflows === null) return new Set();
    return new Set(
      Object.entries(workflows).flatMap(([workflow, policy]) => (policy == null ? [] : [workflow]))
    );
  },

  /** The agents with a replica up, as the controller's governance reads them; any other is down. */
  async read_up_agents(redis: RedisClient): Promise<Set<string>> {
    return new Set(await redis.smembers(UP_AGENTS_KEY));
  },

  /** Each agent's span cost since its own start, over the spans of the workflow's whole workflow
   * group, whose controllers share governance:spend; from one query; agents with none read 0. */
  async spend_since(
    workflow_id: string,
    agents: readonly { readonly name: string; readonly since: string }[]
  ): Promise<Map<string, number>> {
    if (agents.length === 0) return new Map();
    const earliest = Math.min(...agents.map(({ since }) => Date.parse(since)));
    const range = {
      from: new Date(earliest).toISOString(),
      to: new Date(Date.now() + DAY_MS).toISOString(),
    };
    const governed = sql.join(
      agents.map(({ name, since }) => sql`(${name}::text, ${since}::timestamptz)`),
      sql`, `
    );
    const rows = (await db.execute(sql`
      with scoped as (${workflowGroupSpans(workflow_id, range)}),
      governed (agent, since) as (values ${governed})
      select g.agent, coalesce(sum(${sql.raw(spanCost('s'))}), 0)::float8 as usd
      from governed g
      left join scoped s
        on ${sql.raw(spanAgentName('s'))} = g.agent
        and s.start_time_unix_nano >= (extract(epoch from g.since) * 1e9)::bigint
      group by g.agent
    `)) as unknown as { agent: string; usd: number }[];
    return new Map(rows.map(({ agent, usd }) => [agent, Number(usd)]));
  },

  /** Distinct caller to callee agent pairs over the last week of the workflow's spans. */
  async call_edges(workflow_id: string): Promise<{ source: string; target: string }[]> {
    const now = Date.now();
    const range = {
      from: new Date(now - EDGE_DAYS * DAY_MS).toISOString(),
      to: new Date(now + DAY_MS).toISOString(),
    };
    const rows = await db.execute(sql`
      with scoped as (${workflowSpans(workflow_id, range)})
      select distinct ${sql.raw(spanAgentName('parent'))} as source,
        ${sql.raw(spanAgentName('child'))} as target
      from scoped child
      join scoped parent
        on parent.span_id = child.parent_span_id and parent.trace_id = child.trace_id
      where ${sql.raw(spanAgentName('parent'))} <> ${sql.raw(spanAgentName('child'))}
      order by source, target
    `);
    return rows as unknown as { source: string; target: string }[];
  },
};
