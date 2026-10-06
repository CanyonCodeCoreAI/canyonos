import { createHash } from 'node:crypto';

import { z } from 'zod';
import type { RedisClient } from 'bun';

import { db } from '@api/db/client';
import { badGateway, notFound } from '@core/errors';

import { assert_project_running, with_redis } from '../canyonos/canyonos.redis';
import {
  insert_system_prompts,
  list_system_prompts,
  lock_project,
  set_live_system_prompt,
} from './prompts.repo';
import { next_revision, SystemPromptSchema, version_parts } from './prompts.types';
import type { Tx } from './prompts.repo';
import type {
  Prompt,
  PromptListItem,
  PromptLive,
  SystemPrompt,
  SystemPromptCreate,
} from './prompts.types';

const CONFIG_KEY = 'prompts:config';
const YAML_KEY = 'prompts:yaml';

/** A system prompt as prompts.yaml and the stored rows carry it; `live` marks the one agents get. */
const StoredSystemPromptSchema = SystemPromptSchema.extend({ live: z.boolean().optional() });

/** The prompts.yaml document; entries that are not version lists are kept but expose no prompt. */
const PromptsConfigSchema = z
  .object({ prompts: z.record(z.string(), z.unknown()).default({}) })
  .passthrough();
type PromptsConfig = z.infer<typeof PromptsConfigSchema>;

function config_invalid(reason: string, cause: unknown) {
  return badGateway('prompts.config_invalid', `The running controller's ${YAML_KEY} ${reason}`, {
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

/** The prompt's valid versions newest first (highest n, the newer on a tie); live is the one
 * flagged `live`, else the newest. */
function parse_prompt(name: string, entry: unknown): Prompt | null {
  const stored = versions_of(entry)
    .flatMap((spec) => {
      const result = StoredSystemPromptSchema.safeParse(spec);
      return result.success ? [result.data] : [];
    })
    .sort(
      (a, b) =>
        version_parts(b.version).revision - version_parts(a.version).revision ||
        (b.updated_at ?? '').localeCompare(a.updated_at ?? '')
    );
  const [newest] = stored;
  if (!newest) return null;
  const versions = stored.map(({ live: _, ...version }) => version);
  const live_index = stored.findIndex((version) => version.live);
  return { name, live: versions[live_index === -1 ? 0 : live_index]!, versions };
}

function parse_prompts({ prompts }: PromptsConfig): Prompt[] {
  return Object.entries(prompts).flatMap(([name, entry]) => {
    const item = parse_prompt(name, entry);
    return item ? [item] : [];
  });
}

function find_prompt({ prompts }: PromptsConfig, name: string): Prompt {
  const item = parse_prompt(name, prompts[name]);
  if (!item) throw notFound('prompts.prompt_not_found', `Prompt "${name}" was not found`);
  return item;
}

/** `<agent>-<function>-<text hash>-v<n>`, where n counts the saves of this prompt. */
function next_version(prompt: Prompt, content: string): string {
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 8);
  return `${prompt.name.replaceAll('.', '-')}-${hash}-v${next_revision(prompt)}`;
}

function list_item({ name, live }: Prompt): PromptListItem {
  return { name, live };
}

/** The project's stored prompts, shaped like prompts.yaml with `live` on each version. */
async function stored_config(
  reader: Pick<typeof db, 'select'>,
  project_id: string
): Promise<PromptsConfig> {
  const prompts: Record<string, unknown[]> = {};
  for (const { name, version, content, live, created_at } of await list_system_prompts(
    reader,
    project_id
  )) {
    (prompts[name] ??= []).push({
      version,
      content,
      updated_at: created_at.toISOString(),
      live,
    });
  }
  return { prompts };
}

/**
 * Apply `change` to the project's stored prompts, then publish each one's live version to
 * prompts:config. The project row is locked so writes to one project land in commit order; it
 * exists because every caller resolved the project first (the routes) or created it (the boot).
 */
async function write_prompts(
  redis: RedisClient,
  project_id: string,
  change: (tx: Tx, stored: PromptsConfig) => Promise<unknown>
): Promise<PromptsConfig> {
  return db.transaction(async (tx) => {
    await lock_project(tx, project_id);
    await change(tx, await stored_config(tx, project_id));
    const config = await stored_config(tx, project_id);
    const live = parse_prompts(config).map(({ name, live }) => [name, live]);
    await redis.set(CONFIG_KEY, JSON.stringify({ prompts: Object.fromEntries(live) }));
    return config;
  });
}

/** The prompts.yaml prompts that `stored` does not have, every version of each. */
function new_yaml_prompts(yaml: PromptsConfig, stored: PromptsConfig): Prompt[] {
  return parse_prompts(yaml).filter((item) => !stored.prompts[item.name]);
}

async function store_new_yaml_prompts(
  tx: Tx,
  project_id: string,
  yaml: PromptsConfig,
  stored: PromptsConfig
): Promise<void> {
  await insert_system_prompts(
    tx,
    new_yaml_prompts(yaml, stored).flatMap((item) =>
      item.versions.map(({ version, content, updated_at }) => ({
        project_id,
        name: item.name,
        version,
        content,
        live: version === item.live.version,
        created_at: updated_at ? new Date(updated_at) : undefined,
      }))
    )
  );
}

/** At startup, store prompts.yaml's prompts not stored yet, then publish every live version. */
export async function load_prompts(project_id: string): Promise<void> {
  await with_redis(async (redis) => {
    const yaml = parse_config(await redis.get(YAML_KEY));
    await write_prompts(redis, project_id, (tx, stored) =>
      store_new_yaml_prompts(tx, project_id, yaml, stored)
    );
  });
}

/** A prompt added to prompts.yaml since startup is stored on the next listing, so it shows up. */
async function store_prompts_added_to_yaml(redis: RedisClient, project_id: string): Promise<void> {
  const yaml = parse_config(await redis.get(YAML_KEY));
  if (new_yaml_prompts(yaml, await stored_config(db, project_id)).length === 0) return;
  await write_prompts(redis, project_id, (tx, stored) =>
    store_new_yaml_prompts(tx, project_id, yaml, stored)
  );
}

export async function list_prompts(project_id: string): Promise<PromptListItem[]> {
  return with_redis(async (redis) => {
    await assert_project_running(redis, project_id);
    await store_prompts_added_to_yaml(redis, project_id);
    return parse_prompts(await stored_config(db, project_id)).map(list_item);
  });
}

export async function get_prompt(project_id: string, name: string): Promise<Prompt> {
  return with_redis(async (redis) => {
    await assert_project_running(redis, project_id);
    return find_prompt(await stored_config(db, project_id), name);
  });
}

/** Store the text as the prompt's next system prompt; the live one stays live. */
export async function create_system_prompt(
  project_id: string,
  name: string,
  { content }: SystemPromptCreate
): Promise<SystemPrompt> {
  return with_redis(async (redis) => {
    await assert_project_running(redis, project_id);
    let version = '';
    const config = await write_prompts(redis, project_id, (tx, stored) => {
      version = next_version(find_prompt(stored, name), content);
      return insert_system_prompts(tx, [{ project_id, name, version, content }]);
    });
    return find_prompt(config, name).versions.find((stored) => stored.version === version)!;
  });
}

/** Make one of the prompt's stored system prompts the one agents are sent. */
export async function set_live(
  project_id: string,
  name: string,
  { version }: PromptLive
): Promise<PromptListItem> {
  return with_redis(async (redis) => {
    await assert_project_running(redis, project_id);
    const config = await write_prompts(redis, project_id, (tx, stored) => {
      if (!find_prompt(stored, name).versions.some((stored) => stored.version === version)) {
        throw notFound('prompts.version_not_found', `Prompt "${name}" has no version "${version}"`);
      }
      return set_live_system_prompt(tx, project_id, name, version);
    });
    return list_item(find_prompt(config, name));
  });
}
