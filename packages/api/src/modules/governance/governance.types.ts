// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

/** What a tripped spend rule does: rewrite the model of every LLM call, or refuse the call. */
export const CostActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('switch_model'), model: z.string().min(1) }),
  z.object({ kind: z.literal('deny') }),
]);

export const SpendRuleSchema = z.object({
  above_usd: z.number().positive(),
  action: CostActionSchema,
});

// Duplicated from canyonos_core.controller.governance, whose Local Controllers run the gates: how
// long a reviewer has to answer before a gated call fails with `review.timed_out`, and the longest
// reviewer group name.
export const REVIEW_TIMEOUT_DEFAULT_SECONDS = 3600;
export const REVIEW_TIMEOUT_MIN_SECONDS = 60;
export const REVIEW_TIMEOUT_MAX_SECONDS = 3600;
export const REVIEWERS_MAX_LENGTH = 100;

/**
 * A review gate: during a request, every call to the agent waits for a person in the reviewer
 * group `reviewers` to approve it, answered at the endpoint like any question to the person.
 */
export const ReviewRuleSchema = z.object({
  reviewers: z.string().min(1).max(REVIEWERS_MAX_LENGTH),
  timeout_seconds: z
    .number()
    .int()
    .min(REVIEW_TIMEOUT_MIN_SECONDS)
    .max(REVIEW_TIMEOUT_MAX_SECONDS)
    .optional(),
});

/**
 * One agent's rules. `requires` lists, by agent_id, the agents that must have a replica up;
 * `spend.since` is when the counter starts, stamped by whoever saves the rules without one.
 * `review` puts a person's approval in front of each of its calls: null removes it, and a body
 * without it keeps the stored one, so a client that doesn't know review gates never drops one.
 */
export const AgentRulesSchema = z.object({
  requires: z.array(z.string().min(1)),
  spend: z
    .object({
      since: z.string().datetime().optional(),
      rules: z.array(SpendRuleSchema),
    })
    .nullable(),
  review: ReviewRuleSchema.nullable().optional(),
});

/** An agent's rules as saved: its review gate, if any, with the timeout it runs with. */
export const SavedAgentRulesSchema = AgentRulesSchema.extend({
  review: ReviewRuleSchema.required().nullable(),
});

/** `stopped` when its desired replicas are 0, `unknown` before the controller's first sample. */
export const AgentStatusSchema = z.enum(['up', 'down', 'stopped', 'unknown']);

export const AgentSpendSchema = z.object({
  since: z.string().datetime(),
  usd: z.number(),
  /**
   * What the rule with the highest threshold the spend passed does to the agent's calls now; null
   * while the spend is within every threshold.
   */
  tripped_action: CostActionSchema.nullable(),
});

export const GovernanceAgentSchema = z.object({
  /** One per agent name in its workflow; it addresses the agent in this API. */
  agent_id: z.string(),
  name: z.string(),
  replicas_running: z.number().int().nonnegative(),
  /** The count the agent's spec configures. */
  replicas_expected: z.number().int().nonnegative(),
  /** The count the controller is converging to: the spec's until scaling or a stop moves it. */
  desired_replicas: z.number().int().nonnegative(),
  status: AgentStatusSchema,
  /** The agent_ids of the required agents that are not up right now. */
  unmet_requires: z.array(z.string()),
  /**
   * The model ids llms.yaml lets this agent use, the choices for a switch_model action; null when
   * the workflow has no llms.yaml, so any model may be named.
   */
  models: z.array(z.string()).nullable(),
  rules: SavedAgentRulesSchema,
  /** Null while the agent has no spend rules. */
  spend: AgentSpendSchema.nullable(),
  /** A scaling policy brings a stopped agent back to its min_replicas. */
  scaling_policy_present: z.boolean(),
});

/** One agent calling another, each by its agent_id, seen in the last week of traces. */
export const GovernanceEdgeSchema = z.object({ source: z.string(), target: z.string() });

export const GovernanceResponseSchema = z.object({
  agents: z.array(GovernanceAgentSchema),
  edges: z.array(GovernanceEdgeSchema),
});

export const StoppedBodySchema = z.object({ stopped: z.boolean() });

export type CostAction = z.infer<typeof CostActionSchema>;
export type SpendRule = z.infer<typeof SpendRuleSchema>;
export type ReviewRule = z.infer<typeof ReviewRuleSchema>;
export type AgentRules = z.infer<typeof AgentRulesSchema>;
export type SavedAgentRules = z.infer<typeof SavedAgentRulesSchema>;
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export type AgentSpend = z.infer<typeof AgentSpendSchema>;
export type GovernanceAgent = z.infer<typeof GovernanceAgentSchema>;
export type GovernanceEdge = z.infer<typeof GovernanceEdgeSchema>;
export type GovernanceResponse = z.infer<typeof GovernanceResponseSchema>;
export type StoppedBody = z.infer<typeof StoppedBodySchema>;
