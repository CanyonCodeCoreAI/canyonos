import { createHash } from 'node:crypto';

import { badGateway, conflict, notFound } from '@core/errors';

import { assert_project_running, with_redis } from '../canyonos/canyonos.redis';
import { PromptItemSchema, PromptsConfigSchema } from './prompts.types';
import type { PromptEdit, PromptItem, PromptsConfig, PromptsResponse } from './prompts.types';

const CONFIG_KEY = 'prompts:config';
const SAVE_ATTEMPTS = 5;

function config_invalid(reason: string, cause: unknown) {
  return badGateway('prompts.config_invalid', `The running controller's ${CONFIG_KEY} ${reason}`, {
    cause,
  });
}

function parse_config(raw: string | null): PromptsConfig {
  let document: unknown;
  try {
    document = JSON.parse(raw ?? '{}');
  } catch (error) {
    throw config_invalid('is not valid JSON', error);
  }
  const result = PromptsConfigSchema.safeParse(document);
  if (!result.success) throw config_invalid('is not a prompts document', result.error);
  return result.data;
}

function versions_of(entry: unknown): unknown[] {
  return Array.isArray(entry) ? entry : [];
}

/** The trailing n of `<agent>-<function>-<text hash>-<n>`, or 0 when the version has none. */
function revision(version: string): number {
  const suffix = version.split('-').at(-1) ?? '';
  return /^\d+$/.test(suffix) ? Number(suffix) : 0;
}

/** Each prompt's current version: the one with the highest n, the newer on a tie. */
function parse_prompts(config: PromptsConfig): PromptItem[] {
  return Object.entries(config.prompts).flatMap(([name, entry]) => {
    const items = versions_of(entry).flatMap((spec) => {
      const result = PromptItemSchema.safeParse({ ...(spec as object), name });
      return result.success ? [result.data] : [];
    });
    const [current] = items.sort(
      (a, b) =>
        revision(b.version) - revision(a.version) ||
        (b.updated_at ?? '').localeCompare(a.updated_at ?? '')
    );
    return current ? [current] : [];
  });
}

/** `<agent>-<function>-<text hash>-<n>`, where n counts the saves of this prompt. */
function next_version(name: string, previous: string, edit: PromptEdit): string {
  const hash = createHash('sha256')
    .update(`${edit.system}\n${edit.user}`)
    .digest('hex')
    .slice(0, 8);
  return `${name.replaceAll('.', '-')}-${hash}-${revision(previous) + 1}`;
}

export async function get_prompts(project_id: string): Promise<PromptsResponse> {
  return with_redis(async (redis) => {
    await assert_project_running(redis, project_id);
    return { project_id, items: parse_prompts(parse_config(await redis.get(CONFIG_KEY))) };
  });
}

export async function save_prompt(
  project_id: string,
  name: string,
  edit: PromptEdit
): Promise<PromptItem> {
  return with_redis(async (redis) => {
    await assert_project_running(redis, project_id);

    // WATCH makes EXEC a no-op (null) when another writer touched the key after our read.
    for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt += 1) {
      await redis.send('WATCH', [CONFIG_KEY]);
      const config = parse_config(await redis.get(CONFIG_KEY));
      const current = parse_prompts(config).find((prompt) => prompt.name === name);
      if (!current) {
        throw notFound(
          'prompts.prompt_not_found',
          `Prompt "${name}" was not found in the running config`
        );
      }

      const saved = {
        version: next_version(name, current.version, edit),
        ...edit,
        updated_at: new Date().toISOString(),
      };
      const next = {
        ...config,
        prompts: { ...config.prompts, [name]: [...versions_of(config.prompts[name]), saved] },
      };
      await redis.send('MULTI', []);
      await redis.send('SET', [CONFIG_KEY, JSON.stringify(next)]);
      const committed = await redis.send('EXEC', []);
      if (committed !== null) return { name, ...saved };
    }

    throw conflict(
      'prompts.save_conflict',
      `Prompt "${name}" kept changing while it was being saved, try again`
    );
  });
}
