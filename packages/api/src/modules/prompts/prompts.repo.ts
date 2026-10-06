import { and, eq } from 'drizzle-orm';

import { projects, systemPrompts } from '@api/db/schema';
import type { db } from '@api/db/client';

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Reader = Pick<typeof db, 'select'>;

export type SystemPromptRow = typeof systemPrompts.$inferSelect;
export type NewSystemPromptRow = typeof systemPrompts.$inferInsert;

export async function list_system_prompts(
  reader: Reader,
  project_id: string
): Promise<SystemPromptRow[]> {
  return reader.select().from(systemPrompts).where(eq(systemPrompts.project_id, project_id));
}

/** Locks the project row for the transaction, so prompt writes to one project run one at a time. */
export async function lock_project(tx: Tx, project_id: string): Promise<void> {
  await tx
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, project_id))
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
  project_id: string,
  name: string,
  version: string
): Promise<void> {
  const prompt = and(eq(systemPrompts.project_id, project_id), eq(systemPrompts.name, name));
  await tx.update(systemPrompts).set({ live: false }).where(prompt);
  await tx
    .update(systemPrompts)
    .set({ live: true })
    .where(and(prompt, eq(systemPrompts.version, version)));
}
