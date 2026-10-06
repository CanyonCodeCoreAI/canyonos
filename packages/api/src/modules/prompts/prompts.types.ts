import { z } from 'zod';

/** One stored system prompt: a version of what an agent function is sent. */
export const SystemPromptSchema = z.object({
  version: z.coerce.string(),
  content: z.string(),
  updated_at: z.string().nullable().default(null),
});

/** A prompt as the listing carries it: the function and the system prompt agents get. */
export const PromptListItemSchema = z.object({
  name: z.string(),
  live: SystemPromptSchema,
});

/** A prompt with every stored system prompt, newest first. `live` is one of `versions`. */
export const PromptSchema = PromptListItemSchema.extend({
  versions: z.array(SystemPromptSchema),
});

export const SystemPromptCreateSchema = z.object({
  content: SystemPromptSchema.shape.content.min(1),
});

export const PromptLiveSchema = z.object({
  version: SystemPromptSchema.shape.version.min(1),
});

export type SystemPrompt = z.infer<typeof SystemPromptSchema>;
export type PromptListItem = z.infer<typeof PromptListItemSchema>;
export type Prompt = z.infer<typeof PromptSchema>;
export type SystemPromptCreate = z.infer<typeof SystemPromptCreateSchema>;
export type PromptLive = z.infer<typeof PromptLiveSchema>;

/** Splits `<agent>.<function>`; a name without a dot is all agent. */
export function prompt_name_parts(name: string): {
  readonly agent: string;
  readonly function: string | null;
} {
  const dot = name.indexOf('.');
  if (dot === -1) return { agent: name, function: null };
  return { agent: name.slice(0, dot), function: name.slice(dot + 1) };
}

/**
 * Splits `<agent>-<function>-<hash>-v<n>`: `revision` is n (0 when the version has none), `hash`
 * the content hash, and `label` the `v<n>` to show. Any other string is shown as is.
 */
export function version_parts(version: string): {
  readonly revision: number;
  readonly hash: string | null;
  readonly label: string;
} {
  const match = /-([0-9a-f]+)-v(\d+)$/.exec(version);
  if (match) return { revision: Number(match[2]), hash: match[1]!, label: `v${match[2]}` };
  const n = /-v(\d+)$/.exec(version)?.[1];
  return { revision: n ? Number(n) : 0, hash: null, label: version };
}

/** The n the prompt's next version gets: one past its newest. */
export function next_revision(prompt: Pick<Prompt, 'versions'>): number {
  return version_parts(prompt.versions[0]?.version ?? '').revision + 1;
}
