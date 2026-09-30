import { z } from 'zod';

export const PromptItemSchema = z.object({
  name: z.string(),
  version: z.coerce.string(),
  system: z.string(),
  user: z.string(),
  updated_at: z.string().nullable().default(null),
});

export const PromptEditSchema = z.object({
  system: z.string().min(1),
  user: z.string().min(1),
});

export const PromptsResponseSchema = z.object({
  project_id: z.string(),
  items: z.array(PromptItemSchema),
});

/** The `prompts:config` document; entries that are not version lists are kept but expose no prompt. */
export const PromptsConfigSchema = z
  .object({ prompts: z.record(z.string(), z.unknown()).default({}) })
  .passthrough();

export type PromptItem = z.infer<typeof PromptItemSchema>;
export type PromptEdit = z.infer<typeof PromptEditSchema>;
export type PromptsResponse = z.infer<typeof PromptsResponseSchema>;
export type PromptsConfig = z.infer<typeof PromptsConfigSchema>;
