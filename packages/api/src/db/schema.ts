// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import type { WorkflowGraph } from '@api/modules/workflow-groups/workflow-groups.types';

// snake_case column keys so `$inferSelect` matches the snake_case API payload directly — the repos
// select the exact shape without a rename mapper.
export const workflows = pgTable('workflows', {
  id: uuid('id')
    .primaryKey()
    .$defaultFn(() => Bun.randomUUIDv7()),
  name: text('name').notNull(),
  // Temporary: applied now so multi-workflow dashboards work without blocking the flow; revisit
  // with the workflow-key design in CAN-521 (the api should not hold per-workflow Redis addresses).
  redis_host: text('redis_host'),
  redis_port: integer('redis_port'),
  redis_password: text('redis_password'),
  // The client certificate a Docker workflow group's Redis takes, as sealed JSON.
  redis_tls: text('redis_tls'),
  // The workflow shares this workflow group's machines and Redis.
  workflow_group_id: uuid('workflow_group_id'),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

/** A workflow as its last upload left it: its name, each file's SHA-256 by `<name>/<path>`, its
 * `config/test_query.txt`, and the agent graph read from its code, which uploads before the API
 * read graphs, or one whose code couldn't be read, lack. */
export interface StoredWorkflow {
  name: string;
  digests: Record<string, string>;
  test_query: string | null;
  graph?: WorkflowGraph | null;
}

/** The fingerprints the Global Controller container was last started or reloaded with. */
export interface DeployedFingerprints {
  code: string;
  config: string;
  auth: { apiKeyHash?: string };
}

export interface StoredLastApply {
  generation: number;
  action: 'none' | 'start' | 'restart' | 'reload' | 'stop';
  ok: boolean;
  error: string | null;
  code:
    | 'config_invalid'
    | 'reload_failed'
    | 'reload_timeout'
    | 'stop_timeout'
    | 'stop_failed'
    | 'start_failed'
    | null;
}

// One row per workflow group /v1 drives on Docker: what the CLI uploaded (the files themselves
// are in the Global Controller container's /workspace volume) and how far the apply loop got. It
// holds no secrets: the `.env` is kept only as its digest.
export const workflowGroups = pgTable('workflow_groups', {
  // The `workflow_group_id` of its workflow_group.yaml.
  id: uuid('id').primaryKey(),
  name: text('name').notNull().default(''),
  // workflow_group.yaml's text, null until a PUT sends one.
  config: text('config'),
  // The SHA-256 of the `.env` beside it, null for none.
  env_digest: text('env_digest'),
  api_key_hash: text('api_key_hash'),
  // The Global Controller container the upload went into; another one starts from nothing.
  controller_container_id: text('controller_container_id'),
  workflows: jsonb('workflows').$type<Record<string, StoredWorkflow>>().notNull().default({}),
  generation: integer('generation').notNull().default(0),
  applied_generation: integer('applied_generation').notNull().default(0),
  last_change_at: timestamp('last_change_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  deployed: jsonb('deployed').$type<DeployedFingerprints>(),
  last_apply: jsonb('last_apply').$type<StoredLastApply>(),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

// One row per stored version of an agent function's system prompt. The first versions come from
// the workflow's prompts.yaml; dashboard saves add the rest. `live` marks the version agents are sent.
export const systemPrompts = pgTable(
  'system_prompts',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    workflow_id: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    // `<Agent>.<function>`: the function whose LLM calls get this prompt.
    name: text('name').notNull(),
    // `<Agent>-<function>-<content hash>-v<n>`. Kept as the one string instead of normalized
    // columns because it is the identifier the gateway records on every LLM call's span.
    version: text('version').notNull(),
    content: text('content').notNull(),
    live: boolean('live').notNull().default(false),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_system_prompts_workflow_name').on(table.workflow_id, table.name),
    uniqueIndex('uq_system_prompts_workflow_name_version').on(
      table.workflow_id,
      table.name,
      table.version
    ),
  ]
);
