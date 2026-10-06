import { RedisClient } from 'bun';
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { asc, eq } from 'drizzle-orm';

import { db } from '@api/db/client';
import { systemPrompts } from '@api/db/schema';

import { load_prompts } from '../modules/prompts/prompts.service';
import { api, setupE2ETests } from './e2e.setup';
import { authenticate, bearer, create_test_project } from './project-test.utils';
import { read_prompts_config, reset_controller, seed_running_project } from './redis-test.utils';
import type { PromptsConfig } from './redis-test.utils';

setupE2ETests();

/** The project's stored prompt rows as `[name, version, live]`, sorted by version. */
const recorded = async (project_id: string) =>
  (
    await db
      .select()
      .from(systemPrompts)
      .where(eq(systemPrompts.project_id, project_id))
      .orderBy(asc(systemPrompts.version))
  ).map(({ name, version, live }) => [name, version, live]);

const error_code = (res: { error: { value?: unknown } | null }) =>
  (res.error?.value as { error?: string } | undefined)?.error;

const stored = (n: number, updated_at: string, content = `system ${n}`) => ({
  version: `intent-parse-0000000${n}-v${n}`,
  content,
  updated_at,
});

// Revision 2 is dated after revision 3 on purpose: the current version is the highest n, not the
// latest date.
const CONFIG: PromptsConfig = {
  prompts: {
    'intent.parse': [stored(3, '2026-09-20T00:00:00.000Z'), stored(2, '2026-09-25T00:00:00.000Z')],
    summarize: [
      {
        version: 'summarize-abcdef01-v1',
        content: 'Summarize the input.',
        updated_at: '2026-09-01T00:00:00.000Z',
      },
    ],
  },
};
const INTENT_V3 = stored(3, '2026-09-20T00:00:00.000Z');
const SUMMARIZE_V1 = CONFIG.prompts.summarize![0]!;

const EDIT = { content: 'edited system' };

async function running_project(email: string): Promise<{ token: string; project_id: string }> {
  const token = await authenticate(email);
  const { project_id } = await create_test_project(token, { name: 'Prompts Project' });
  await seed_running_project(project_id, CONFIG);
  await load_prompts(project_id);
  return { token, project_id };
}

describe('project prompts', () => {
  beforeEach(reset_controller);

  test('the listing carries each prompt with its live version, the highest n', async () => {
    const { token, project_id } = await running_project('prompts-list@canyonos.test');

    const res = await api.projects[project_id]!.prompts.get({ $headers: bearer(token) });

    expect(res.error).toBeNull();
    expect(res.data).toEqual([
      { name: 'intent.parse', live: INTENT_V3 },
      { name: 'summarize', live: SUMMARIZE_V1 },
    ]);
  });

  test('a prompt carries every version newest first, and an unknown name is 404', async () => {
    const { token, project_id } = await running_project('prompts-get@canyonos.test');
    const headers = bearer(token);

    const res = await api.projects[project_id]!.prompts['intent.parse']!.get({ $headers: headers });

    expect(res.error).toBeNull();
    expect(res.data).toEqual({
      name: 'intent.parse',
      live: INTENT_V3,
      versions: [INTENT_V3, stored(2, '2026-09-25T00:00:00.000Z')],
    });

    const missing = await api.projects[project_id]!.prompts.missing!.get({ $headers: headers });
    expect(missing.error?.status as number).toBe(404);
    expect(error_code(missing)).toBe('prompts.prompt_not_found');
  });

  test('creating a version appends the next revision and keeps the live one live', async () => {
    const { token, project_id } = await running_project('prompts-save@canyonos.test');
    const headers = bearer(token);
    const prompt = api.projects[project_id]!.prompts['intent.parse']!;

    const created = await prompt.versions.post(EDIT, { headers });

    expect(created.error).toBeNull();
    expect(created.status).toBe(201);
    const newest = created.data!.version;
    expect(newest).toMatch(/^intent-parse-[0-9a-f]{8}-v4$/);
    expect(created.data).toMatchObject(EDIT);
    expect(Number.isNaN(Date.parse(created.data?.updated_at ?? ''))).toBe(false);

    const read = await prompt.get({ $headers: headers });
    expect(read.data?.live).toEqual(INTENT_V3);
    expect(read.data?.versions[0]).toEqual(created.data!);

    expect(await read_prompts_config()).toEqual({
      prompts: { 'intent.parse': INTENT_V3, summarize: SUMMARIZE_V1 },
    });
    expect(await recorded(project_id)).toEqual([
      ['intent.parse', 'intent-parse-00000002-v2', false],
      ['intent.parse', 'intent-parse-00000003-v3', true],
      ['intent.parse', newest, false],
      ['summarize', 'summarize-abcdef01-v1', true],
    ]);
  });

  test('setting an older version live moves the live flag to it', async () => {
    const { token, project_id } = await running_project('prompts-live@canyonos.test');
    const headers = bearer(token);
    const prompt = api.projects[project_id]!.prompts['intent.parse']!;

    const res = await prompt.live.put({ version: 'intent-parse-00000002-v2' }, { headers });

    expect(res.error).toBeNull();
    expect(res.data).toEqual({
      name: 'intent.parse',
      live: stored(2, '2026-09-25T00:00:00.000Z'),
    });
    const config = await read_prompts_config();
    expect(config?.prompts['intent.parse']?.version).toBe('intent-parse-00000002-v2');
    const listed = await api.projects[project_id]!.prompts.get({ $headers: headers });
    expect(listed.data?.[0]?.live.version).toBe('intent-parse-00000002-v2');

    const unknown = await prompt.live.put({ version: 'intent-parse-ffffffff-v9' }, { headers });
    expect(unknown.error?.status as number).toBe(404);
    expect(error_code(unknown)).toBe('prompts.version_not_found');

    const newest = (await prompt.versions.post(EDIT, { headers })).data!.version;
    expect((await prompt.live.put({ version: newest }, { headers })).error).toBeNull();
    expect(await recorded(project_id)).toEqual([
      ['intent.parse', 'intent-parse-00000002-v2', false],
      ['intent.parse', 'intent-parse-00000003-v3', false],
      ['intent.parse', newest, true],
      ['summarize', 'summarize-abcdef01-v1', true],
    ]);
  });

  test('a version for a prompt the config does not have is 404 prompts.prompt_not_found', async () => {
    const { token, project_id } = await running_project('prompts-unknown@canyonos.test');

    const before = await read_prompts_config();
    const res = await api.projects[project_id]!.prompts.missing!.versions.post(EDIT, {
      headers: bearer(token),
    });

    expect(res.error?.status as number).toBe(404);
    expect(error_code(res)).toBe('prompts.prompt_not_found');
    expect(await read_prompts_config()).toEqual(before);
  });

  test('a project the controller is not running is 404 canyonos.project_not_running', async () => {
    const token = await authenticate('prompts-not-running@canyonos.test');
    const headers = bearer(token);
    const { project_id } = await create_test_project(token, { name: 'Idle Project' });
    const { project_id: running_id } = await create_test_project(token, { name: 'Running' });
    await seed_running_project(running_id, CONFIG);
    const before = await read_prompts_config();
    const prompt = api.projects[project_id]!.prompts['intent.parse']!;

    const listed = await api.projects[project_id]!.prompts.get({ $headers: headers });
    const read = await prompt.get({ $headers: headers });
    const created = await prompt.versions.post(EDIT, { headers });
    const live = await prompt.live.put({ version: 'intent-parse-00000003-v3' }, { headers });

    for (const res of [listed, read, created, live]) {
      expect(res.error?.status as number).toBe(404);
      expect(error_code(res)).toBe('canyonos.project_not_running');
    }
    expect(await read_prompts_config()).toEqual(before);
  });

  test('an empty system prompt is rejected before anything is stored', async () => {
    const { token, project_id } = await running_project('prompts-invalid@canyonos.test');
    const headers = bearer(token);
    const prompt = api.projects[project_id]!.prompts['intent.parse']!;

    const before = await read_prompts_config();
    const res = await prompt.versions.post({ content: '' }, { headers });

    expect(res.error?.status as number).toBe(422);
    expect(await read_prompts_config()).toEqual(before);
  });

  test('a caller with no token is rejected on every route', async () => {
    const { project_id } = await running_project('prompts-anon@canyonos.test');
    const prompt = api.projects[project_id]!.prompts['intent.parse']!;

    const before = await read_prompts_config();
    const responses = [
      await api.projects[project_id]!.prompts.get(),
      await prompt.get(),
      await prompt.versions.post(EDIT),
      await prompt.live.put({ version: 'intent-parse-00000002-v2' }),
    ];

    for (const res of responses) expect(res.error?.status as number).toBe(401);
    expect(await read_prompts_config()).toEqual(before);
  });

  test('an empty controller config lists no prompts', async () => {
    const token = await authenticate('prompts-empty@canyonos.test');
    const { project_id } = await create_test_project(token, { name: 'Bare Project' });
    await seed_running_project(project_id, { prompts: {} });
    await load_prompts(project_id);

    const res = await api.projects[project_id]!.prompts.get({ $headers: bearer(token) });

    expect(res.error).toBeNull();
    expect(res.data).toEqual([]);
    expect(await read_prompts_config()).toEqual({ prompts: {} });
  });

  test('a redeploy keeps stored prompts over prompts.yaml and stores a prompt new to it', async () => {
    const { token, project_id } = await running_project('prompts-redeploy@canyonos.test');
    const headers = bearer(token);
    const prompt = api.projects[project_id]!.prompts['intent.parse']!;
    const newest = (await prompt.versions.post(EDIT, { headers })).data!.version;
    const added = { version: 'advise-00000001-v1', content: 'Advise.', updated_at: null };

    await seed_running_project(project_id, {
      prompts: {
        ...CONFIG.prompts,
        'intent.parse': [stored(9, '2026-09-30T00:00:00.000Z')],
        advise: [added],
      },
    });
    await load_prompts(project_id);

    expect(await recorded(project_id)).toEqual([
      ['advise', 'advise-00000001-v1', true],
      ['intent.parse', 'intent-parse-00000002-v2', false],
      ['intent.parse', 'intent-parse-00000003-v3', true],
      ['intent.parse', newest, false],
      ['summarize', 'summarize-abcdef01-v1', true],
    ]);
    const config = await read_prompts_config();
    expect(Object.keys(config!.prompts).sort()).toEqual(['advise', 'intent.parse', 'summarize']);
  });

  test('a prompt added to prompts.yaml after startup is stored and listed on the next read', async () => {
    const { token, project_id } = await running_project('prompts-added@canyonos.test');
    const headers = bearer(token);
    const added = { version: 'advise-00000001-v1', content: 'Advise.', updated_at: null };
    await seed_running_project(project_id, {
      prompts: {
        ...CONFIG.prompts,
        'intent.parse': [stored(9, '2026-09-30T00:00:00.000Z')],
        advise: [added],
      },
    });

    const res = await api.projects[project_id]!.prompts.get({ $headers: headers });

    expect(res.error).toBeNull();
    expect(res.data?.map(({ name, live }) => [name, live.version])).toEqual([
      ['intent.parse', 'intent-parse-00000003-v3'],
      ['summarize', 'summarize-abcdef01-v1'],
      ['advise', 'advise-00000001-v1'],
    ]);
    expect(await recorded(project_id)).toEqual([
      ['advise', 'advise-00000001-v1', true],
      ['intent.parse', 'intent-parse-00000002-v2', false],
      ['intent.parse', 'intent-parse-00000003-v3', true],
      ['summarize', 'summarize-abcdef01-v1', true],
    ]);
    expect((await read_prompts_config())?.prompts.advise).toMatchObject({
      version: added.version,
      content: added.content,
    });
  });

  test('two versions created at once get distinct consecutive revisions', async () => {
    const { token, project_id } = await running_project('prompts-concurrent@canyonos.test');
    const headers = bearer(token);
    const prompt = api.projects[project_id]!.prompts['intent.parse']!;

    const [first, second] = await Promise.all([
      prompt.versions.post({ content: 'first' }, { headers }),
      prompt.versions.post({ content: 'second' }, { headers }),
    ]);

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    const versions = (await recorded(project_id))
      .filter(([name]) => name === 'intent.parse')
      .map(([, version]) => version as string);
    const revisions = versions.map((version) => Number(/-v(\d+)$/.exec(version)?.[1]));
    expect(revisions.sort((a, b) => a - b)).toEqual([2, 3, 4, 5]);
    expect(new Set(versions).size).toBe(4);
  });
});

describe('a prompt write whose publish to Redis fails', () => {
  beforeEach(reset_controller);
  afterEach(() => mock.restore());

  const fail_publish = () =>
    spyOn(RedisClient.prototype, 'set').mockRejectedValueOnce(new Error('redis down'));

  test('creating a version stores nothing', async () => {
    const { token, project_id } = await running_project('prompts-save-fails@canyonos.test');
    const before = [await recorded(project_id), await read_prompts_config()];

    fail_publish();
    const res = await api.projects[project_id]!.prompts['intent.parse']!.versions.post(EDIT, {
      headers: bearer(token),
    });

    expect(res.error?.status as number).toBe(500);
    expect([await recorded(project_id), await read_prompts_config()]).toEqual(before);
  });

  test('set live keeps the previous live version', async () => {
    const { token, project_id } = await running_project('prompts-live-fails@canyonos.test');
    const before = [await recorded(project_id), await read_prompts_config()];

    fail_publish();
    const res = await api.projects[project_id]!.prompts['intent.parse']!.live.put(
      { version: 'intent-parse-00000002-v2' },
      { headers: bearer(token) }
    );

    expect(res.error?.status as number).toBe(500);
    expect([await recorded(project_id), await read_prompts_config()]).toEqual(before);
  });

  test('loading prompts.yaml at startup stores nothing', async () => {
    const token = await authenticate('prompts-load-fails@canyonos.test');
    const { project_id } = await create_test_project(token, { name: 'Prompts Project' });
    await seed_running_project(project_id, CONFIG);

    fail_publish();
    const error = await load_prompts(project_id).then(
      () => null,
      (error: unknown) => error
    );

    expect(error).toHaveProperty('message', 'redis down');

    expect(await recorded(project_id)).toEqual([]);
    expect(await read_prompts_config()).toBeNull();
  });
});
