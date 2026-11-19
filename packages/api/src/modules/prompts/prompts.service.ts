// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';

import { z } from 'zod';
import type { RedisClient } from 'bun';

import { db } from '@api/db/client';
import { badGateway, conflict, notFound } from '@core/errors';
import { update_json_key } from '@core/redis';

import { PROMPTS_CONFIG_KEY, PROMPTS_YAML_KEY } from '../registry/registry.contract';
import { assert_workflow_running, with_redis } from '../registry/registry.redis';
import {
  insert_system_prompts,
  list_system_prompts,
  lock_workflow,
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

export const RECONCILE_PROMPTS_FAILED = 'Could not publish the live prompts';

/** A system prompt as prompts.yaml and the stored rows carry it; `live` marks the one agents get. */
const StoredSystemPromptSchema = SystemPromptSchema.extend({ live: z.boolean().optional() });

/** The prompts.yaml document; entries that are not version lists are kept but expose no prompt. */
const PromptsConfigSchema = z
  .object({ prompts: z.record(z.string(), z.unknown()).default({}) })
  .passthrough();
type PromptsConfig = z.infer<typeof PromptsConfigSchema>;

function config_invalid(reason: string, cause: unknown) {
  return badGateway(
    'prompts.config_invalid',
    `The running controller's ${PROMPTS_YAML_KEY} ${reason}`,
    {
      cause,
    }
  );
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

/** Each stored prompt's live version, by name: the workflow's part of prompts:config. */
function live_prompts(stored: PromptsConfig): Record<string, SystemPrompt> {
  return Object.fromEntries(parse_prompts(stored).map(({ name, live }) => [name, live]));
}

/** The workflow's stored prompts, shaped like prompts.yaml with `live` on each version. */
async function stored_config(
  reader: Pick<typeof db, 'select'>,
  workflow_id: string
): Promise<PromptsConfig> {
  const prompts: Record<string, unknown[]> = {};
  for (const { name, version, content, live, created_at } of await list_system_prompts(
    reader,
    workflow_id
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
 * Apply `change` to the workflow's stored prompts, then publish each one's live version to
 * prompts:config beside those of the workflow group's other workflows, retrying while another
 * writer races us; 409 when it kept changing, and nothing is stored. The workflow row is locked
 * so writes to one workflow land in commit order; it exists because every caller resolved the
 * workflow first (the routes) or listed it as registered (the tick).
 */
async function write_prompts(
  redis: RedisClient,
  workflow_id: string,
  workflow: string,
  change: (tx: Tx, stored: PromptsConfig) => Promise<unknown>
): Promise<PromptsConfig> {
  return db.transaction(async (tx) => {
    await lock_workflow(tx, workflow_id);
    await change(tx, await stored_config(tx, workflow_id));
    const config = await stored_config(tx, workflow_id);
    // WATCHed: a write for another workflow of the group, which shares the key, lands between
    // our read and our write only by making us read again, never by being reverted.
    const published = await update_json_key(redis, PROMPTS_CONFIG_KEY, (raw) => {
      const others = Object.entries(parse_config(raw).prompts).filter(
        ([name]) => !name.startsWith(`${workflow}.`)
      );
      return { prompts: { ...Object.fromEntries(others), ...live_prompts(config) } };
    });
    if (!published) {
      throw conflict(
        'prompts.save_conflict',
        "The workflow group's prompts kept changing while they were being saved, try again"
      );
    }
    return config;
  });
}

/** The workflow's prompts.yaml prompts that `stored` does not have, every version of each. */
function new_yaml_prompts(yaml: PromptsConfig, stored: PromptsConfig, workflow: string): Prompt[] {
  return parse_prompts(yaml).filter(
    (item) => item.name.startsWith(`${workflow}.`) && !stored.prompts[item.name]
  );
}

async function store_new_yaml_prompts(
  tx: Tx,
  workflow_id: string,
  workflow: string,
  yaml: PromptsConfig,
  stored: PromptsConfig
): Promise<void> {
  await insert_system_prompts(
    tx,
    new_yaml_prompts(yaml, stored, workflow).flatMap((item) =>
      item.versions.map(({ version, content, updated_at }) => ({
        workflow_id,
        name: item.name,
        version,
        content,
        live: version === item.live.version,
        created_at: updated_at ? new Date(updated_at) : undefined,
      }))
    )
  );
}

/**
 * A redeployed controller publishes prompts.yaml's versions to prompts:config, so the versions
 * made live in the dashboard are lost there. This stores the prompts new to prompts.yaml and
 * republishes the workflow's stored live versions whenever its part of prompts:config differs
 * from them; a registered-workflows job, run on the workflow group's Redis each tick.
 */
export async function reconcile_live_prompts(
  redis: RedisClient,
  workflow_id: string,
  workflow: string
): Promise<void> {
  const yaml = parse_config(await redis.get(PROMPTS_YAML_KEY));
  const stored = await stored_config(db, workflow_id);
  const published = Object.entries(
    parse_config(await redis.get(PROMPTS_CONFIG_KEY)).prompts
  ).filter(([name]) => name.startsWith(`${workflow}.`));
  if (
    new_yaml_prompts(yaml, stored, workflow).length === 0 &&
    Bun.deepEquals(Object.fromEntries(published), live_prompts(stored))
  ) {
    return;
  }
  await write_prompts(redis, workflow_id, workflow, (tx, current) =>
    store_new_yaml_prompts(tx, workflow_id, workflow, yaml, current)
  );
}

/** A prompt added to prompts.yaml since startup is stored on the next listing, so it shows up. */
async function store_prompts_added_to_yaml(
  redis: RedisClient,
  workflow_id: string,
  workflow: string
): Promise<void> {
  const yaml = parse_config(await redis.get(PROMPTS_YAML_KEY));
  if (new_yaml_prompts(yaml, await stored_config(db, workflow_id), workflow).length === 0) return;
  await write_prompts(redis, workflow_id, workflow, (tx, stored) =>
    store_new_yaml_prompts(tx, workflow_id, workflow, yaml, stored)
  );
}

export async function list_prompts(workflow_id: string): Promise<PromptListItem[]> {
  return with_redis(workflow_id, async (redis) => {
    const workflow = await assert_workflow_running(redis, workflow_id);
    await store_prompts_added_to_yaml(redis, workflow_id, workflow);
    return parse_prompts(await stored_config(db, workflow_id)).map(list_item);
  });
}

export async function get_prompt(workflow_id: string, name: string): Promise<Prompt> {
  return with_redis(workflow_id, async (redis) => {
    await assert_workflow_running(redis, workflow_id);
    return find_prompt(await stored_config(db, workflow_id), name);
  });
}

/** Store the text as the prompt's next system prompt; the live one stays live. */
export async function create_system_prompt(
  workflow_id: string,
  name: string,
  { content }: SystemPromptCreate
): Promise<SystemPrompt> {
  return with_redis(workflow_id, async (redis) => {
    const workflow = await assert_workflow_running(redis, workflow_id);
    let version = '';
    const config = await write_prompts(redis, workflow_id, workflow, (tx, stored) => {
      version = next_version(find_prompt(stored, name), content);
      return insert_system_prompts(tx, [{ workflow_id, name, version, content }]);
    });
    return find_prompt(config, name).versions.find((stored) => stored.version === version)!;
  });
}

/** Make one of the prompt's stored system prompts the one agents are sent. */
export async function set_live(
  workflow_id: string,
  name: string,
  { version }: PromptLive
): Promise<PromptListItem> {
  return with_redis(workflow_id, async (redis) => {
    const workflow = await assert_workflow_running(redis, workflow_id);
    const config = await write_prompts(redis, workflow_id, workflow, (tx, stored) => {
      if (!find_prompt(stored, name).versions.some((stored) => stored.version === version)) {
        throw notFound('prompts.version_not_found', `Prompt "${name}" has no version "${version}"`);
      }
      return set_live_system_prompt(tx, workflow_id, name, version);
    });
    return list_item(find_prompt(config, name));
  });
}
