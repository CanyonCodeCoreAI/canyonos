// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from 'drizzle-orm';

import { systemPrompts, workflows } from '@api/db/schema';
import type { db } from '@api/db/client';

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Reader = Pick<typeof db, 'select'>;

export type SystemPromptRow = typeof systemPrompts.$inferSelect;
export type NewSystemPromptRow = typeof systemPrompts.$inferInsert;

export async function list_system_prompts(
  reader: Reader,
  workflow_id: string
): Promise<SystemPromptRow[]> {
  return reader.select().from(systemPrompts).where(eq(systemPrompts.workflow_id, workflow_id));
}

/** Locks the workflow row for the transaction, so prompt writes to one workflow run one at a time. */
export async function lock_workflow(tx: Tx, workflow_id: string): Promise<void> {
  await tx
    .select({ id: workflows.id })
    .from(workflows)
    .where(eq(workflows.id, workflow_id))
    .for('update');
}

export async function insert_system_prompts(tx: Tx, rows: NewSystemPromptRow[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(systemPrompts).values(rows);
}

/** Flags `version` as the prompt's live system prompt and clears the flag on the others. Two
 * statements, so a unique "one live per prompt" index could never see both set at once. */
export async function set_live_system_prompt(
  tx: Tx,
  workflow_id: string,
  name: string,
  version: string
): Promise<void> {
  const prompt = and(eq(systemPrompts.workflow_id, workflow_id), eq(systemPrompts.name, name));
  await tx.update(systemPrompts).set({ live: false }).where(prompt);
  await tx
    .update(systemPrompts)
    .set({ live: true })
    .where(and(prompt, eq(systemPrompts.version, version)));
}
