// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { GEN_AI, RUNTIME_ATTRIBUTES } from '../modules/metrics/metrics.contract';
import { STATUS_CODE, WORKFLOW_ID_ATTRIBUTE } from '../modules/telemetry/telemetry.contract';
import { otelSpans } from '../modules/telemetry/telemetry.schema';
import { db } from './client';
import { workflows } from './schema';

const DEMO_WORKFLOW_NAME = 'Canyon Code Demo Flow';

const SEED_WORKFLOW_NAMESPACE = 'canyon-code/dev-seed/workflow';

const MINUTE_NANOS = 60_000_000_000n;

// Reserve this global advisory-lock key for the dev seed.
const SEED_ADVISORY_LOCK_KEY = 4021749;

interface SeedSpan {
  readonly suffix: string;
  readonly trace: string;
  readonly parent?: string;
  readonly name: string;
  readonly replica_id?: string;
  readonly minutes_ago: bigint;
  readonly duration_minutes: bigint;
  readonly failed?: boolean;
  readonly model?: string;
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly token_cost?: number;
  readonly server_cost?: number;
  readonly error_count?: number;
  readonly input?: string;
  readonly output?: string;
}

// `Retrieval` carries no cost attribute on purpose: the dashboard needs an unpriced block to show.
const SEED_SPANS: readonly SeedSpan[] = [
  {
    suffix: 'intake',
    trace: 'invoice',
    name: 'Intake',
    replica_id: 'intake-0',
    minutes_ago: 95n,
    duration_minutes: 1n,
    server_cost: 0.0004,
    input: 'Review the attached invoice and flag anything unusual.',
  },
  {
    suffix: 'writer-a',
    trace: 'invoice',
    parent: 'intake',
    name: 'Report Writer',
    replica_id: 'writer-0',
    minutes_ago: 94n,
    duration_minutes: 3n,
    model: 'claude-opus-5',
    input_tokens: 18_400,
    output_tokens: 2_600,
    token_cost: 0.412,
    output: 'The invoice totals $1,240.\n\nTwo line items need a second look.',
  },
  {
    suffix: 'retrieve',
    trace: 'invoice',
    parent: 'intake',
    name: 'Retrieval',
    replica_id: 'retrieval-0',
    minutes_ago: 94n,
    duration_minutes: 1n,
  },
  {
    suffix: 'intake-b',
    trace: 'summary',
    name: 'Intake',
    replica_id: 'intake-0',
    minutes_ago: 50n,
    duration_minutes: 1n,
    server_cost: 0.0004,
    input: 'Summarise last week of spend.',
  },
  {
    suffix: 'writer-b',
    trace: 'summary',
    parent: 'intake-b',
    name: 'Report Writer',
    replica_id: 'writer-1',
    minutes_ago: 49n,
    duration_minutes: 2n,
    model: 'claude-haiku-4-5',
    input_tokens: 6_100,
    output_tokens: 900,
    token_cost: 0.0181,
    output: 'Spend rose 12% week over week, driven by the report writer.',
  },
  {
    suffix: 'intake-c',
    trace: 'failed',
    name: 'Intake',
    replica_id: 'intake-0',
    minutes_ago: 20n,
    duration_minutes: 1n,
    server_cost: 0.0004,
    input: 'Reconcile the ledger export.',
  },
  {
    suffix: 'writer-c',
    trace: 'failed',
    parent: 'intake-c',
    name: 'Report Writer',
    replica_id: 'writer-0',
    minutes_ago: 19n,
    duration_minutes: 1n,
    failed: true,
    error_count: 2,
    model: 'claude-opus-5',
    input_tokens: 2_400,
    output_tokens: 40,
    token_cost: 0.0392,
  },
];

type SeedTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Identity is derived, never matched by display name; version 8 is the RFC 9562 custom slot.
function seedWorkflowId(): string {
  const bytes = createHash('sha256').update(SEED_WORKFLOW_NAMESPACE).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

async function ensureDemoWorkflow(tx: SeedTx): Promise<string> {
  const id = seedWorkflowId();
  // Its own workflow group: no Global Controller runs the demo, and its routes need one.
  await tx
    .insert(workflows)
    .values({ id, name: DEMO_WORKFLOW_NAME, workflow_group_id: id })
    .onConflictDoNothing();
  return id;
}

function span_attributes(span: SeedSpan, workflow_id: string): Record<string, unknown> {
  const { replica_id, model, input_tokens, output_tokens } = span;
  const { token_cost, server_cost, error_count } = span;
  const cost = (token_cost ?? 0) + (server_cost ?? 0);

  const attributes: Record<string, unknown> = {
    [WORKFLOW_ID_ATTRIBUTE]: workflow_id,
    [GEN_AI.AGENT_ID]: Bun.randomUUIDv5(span.name, workflow_id),
  };
  if (replica_id !== undefined) attributes[RUNTIME_ATTRIBUTES.REPLICA_ID] = replica_id;
  if (model !== undefined) attributes[GEN_AI.REQUEST_MODEL] = model;
  if (input_tokens !== undefined) attributes[GEN_AI.INPUT_TOKENS] = input_tokens;
  if (output_tokens !== undefined) attributes[GEN_AI.OUTPUT_TOKENS] = output_tokens;
  if (token_cost !== undefined) attributes[RUNTIME_ATTRIBUTES.TOKEN_COST] = token_cost;
  if (server_cost !== undefined) attributes[RUNTIME_ATTRIBUTES.SERVER_COST] = server_cost;
  if (error_count !== undefined) attributes[RUNTIME_ATTRIBUTES.ERROR_COUNT] = error_count;
  if (cost > 0) attributes[GEN_AI.USAGE_COST] = cost;
  return attributes;
}

/** Returns the demo workflow id, which the seed derives from its namespace rather than the name. */
export async function seedDevTelemetry(): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SEED_ADVISORY_LOCK_KEY}::bigint)`);
    const workflow_id = await ensureDemoWorkflow(tx);
    const now = BigInt(Date.now()) * 1_000_000n;
    const span_id = (suffix: string) => `seed-${workflow_id}-${suffix}`;

    const rows = SEED_SPANS.map((span) => {
      const start = now - span.minutes_ago * MINUTE_NANOS;
      return {
        span_id: span_id(span.suffix),
        trace_id: `seed-${workflow_id}-${span.trace}`,
        parent_span_id: span.parent === undefined ? null : span_id(span.parent),
        name: span.name,
        status_code: span.failed === true ? STATUS_CODE.ERROR : STATUS_CODE.UNSET,
        start_time_unix_nano: start,
        end_time_unix_nano: start + span.duration_minutes * MINUTE_NANOS,
        attributes: span_attributes(span, workflow_id),
        input: span.input ?? null,
        output: span.output ?? null,
      };
    });

    // Addresses only seed-owned span ids, and refreshes every column the seed writes.
    await tx
      .insert(otelSpans)
      .values(rows)
      .onConflictDoUpdate({
        target: otelSpans.span_id,
        set: {
          trace_id: sql`excluded.trace_id`,
          parent_span_id: sql`excluded.parent_span_id`,
          name: sql`excluded.name`,
          status_code: sql`excluded.status_code`,
          start_time_unix_nano: sql`excluded.start_time_unix_nano`,
          end_time_unix_nano: sql`excluded.end_time_unix_nano`,
          attributes: sql`excluded.attributes`,
          input: sql`excluded.input`,
          output: sql`excluded.output`,
        },
      });
    return workflow_id;
  });
}
