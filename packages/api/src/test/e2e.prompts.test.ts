import { beforeEach, describe, expect, test } from 'bun:test';

import { api, setupE2ETests } from './e2e.setup';
import { authenticate, bearer, create_test_project } from './project-test.utils';
import { read_prompts_config, reset_controller, seed_running_project } from './redis-test.utils';
import type { PromptsConfig } from './redis-test.utils';

setupE2ETests();

const error_code = (res: { error: { value?: unknown } | null }) =>
  (res.error?.value as { error?: string } | undefined)?.error;

const stored = (n: number, updated_at: string, system = `system ${n}`) => ({
  version: `intent-parse-0000000${n}-${n}`,
  system,
  user: '{query}',
  updated_at,
});

// Revision 2 is dated after revision 3 on purpose: the current version is the highest n, not the
// latest date.
const CONFIG: PromptsConfig = {
  prompts: {
    'intent.parse': [stored(3, '2026-09-20T00:00:00Z'), stored(2, '2026-09-25T00:00:00Z')],
    summarize: [
      {
        version: 'summarize-abcdef01-1',
        system: 'Summarize the input.',
        user: '{text}',
        updated_at: '2026-09-01T00:00:00Z',
      },
    ],
  },
};

const EDIT = { system: 'edited system', user: 'edited {query}' };

async function running_project(email: string): Promise<{ token: string; project_id: string }> {
  const token = await authenticate(email);
  const { project_id } = await create_test_project(token, { name: 'Prompts Project' });
  await seed_running_project(project_id, CONFIG);
  return { token, project_id };
}

describe('project prompts', () => {
  beforeEach(reset_controller);

  test('lists one current version per prompt, the highest n', async () => {
    const { token, project_id } = await running_project('prompts-list@canyonos.test');

    const res = await api.projects[project_id]!.prompts.get({ $headers: bearer(token) });

    expect(res.error).toBeNull();
    expect(res.data).toEqual({
      project_id,
      items: [
        { name: 'intent.parse', ...stored(3, '2026-09-20T00:00:00Z') },
        { name: 'summarize', ...CONFIG.prompts.summarize![0]! },
      ],
    });
  });

  test('saving appends the next revision and keeps the previous ones stored', async () => {
    const { token, project_id } = await running_project('prompts-save@canyonos.test');
    const headers = bearer(token);

    const saved = await api.projects[project_id]!.prompts['intent.parse']!.put(EDIT, { headers });

    expect(saved.error).toBeNull();
    expect(saved.data?.version).toMatch(/^intent-parse-[0-9a-f]{8}-4$/);
    expect(saved.data).toMatchObject({ name: 'intent.parse', ...EDIT });
    expect(Number.isNaN(Date.parse(saved.data?.updated_at ?? ''))).toBe(false);

    const listed = await api.projects[project_id]!.prompts.get({ $headers: headers });
    expect(listed.error).toBeNull();
    expect(listed.data?.items.find(({ name }) => name === 'intent.parse')).toEqual({
      name: 'intent.parse',
      version: saved.data!.version,
      ...EDIT,
      updated_at: saved.data!.updated_at,
    });

    const config = await read_prompts_config();
    expect(config?.prompts['intent.parse']?.map(({ version }) => version)).toEqual([
      'intent-parse-00000003-3',
      'intent-parse-00000002-2',
      saved.data!.version,
    ]);
    expect(config?.prompts.summarize).toEqual(CONFIG.prompts.summarize!);
  });

  test('saving a prompt the config does not have is 404 prompts.prompt_not_found', async () => {
    const { token, project_id } = await running_project('prompts-unknown@canyonos.test');

    const res = await api.projects[project_id]!.prompts.missing!.put(EDIT, {
      headers: bearer(token),
    });

    expect(res.error?.status as number).toBe(404);
    expect(error_code(res)).toBe('prompts.prompt_not_found');
    expect((await read_prompts_config())?.prompts).toEqual(CONFIG.prompts);
  });

  test('a project the controller is not running is 404 canyonos.project_not_running', async () => {
    const token = await authenticate('prompts-not-running@canyonos.test');
    const headers = bearer(token);
    const { project_id } = await create_test_project(token, { name: 'Idle Project' });
    const { project_id: running_id } = await create_test_project(token, { name: 'Running' });
    await seed_running_project(running_id, CONFIG);

    const listed = await api.projects[project_id]!.prompts.get({ $headers: headers });
    const saved = await api.projects[project_id]!.prompts['intent.parse']!.put(EDIT, { headers });

    for (const res of [listed, saved]) {
      expect(res.error?.status as number).toBe(404);
      expect(error_code(res)).toBe('canyonos.project_not_running');
    }
    expect((await read_prompts_config())?.prompts).toEqual(CONFIG.prompts);
  });

  test('an empty system or user prompt is rejected before anything is stored', async () => {
    const { token, project_id } = await running_project('prompts-invalid@canyonos.test');
    const headers = bearer(token);
    const prompt = api.projects[project_id]!.prompts['intent.parse']!;

    const responses = await Promise.all([
      prompt.put({ system: '', user: 'u' }, { headers }),
      prompt.put({ system: 's', user: '' }, { headers }),
    ]);

    for (const res of responses) {
      expect(res.error?.status as number).toBe(422);
    }
    expect((await read_prompts_config())?.prompts).toEqual(CONFIG.prompts);
  });

  test('a caller with no token is rejected on both routes', async () => {
    const { project_id } = await running_project('prompts-anon@canyonos.test');

    const listed = await api.projects[project_id]!.prompts.get();
    const saved = await api.projects[project_id]!.prompts['intent.parse']!.put(EDIT);

    expect(listed.error?.status as number).toBe(401);
    expect(saved.error?.status as number).toBe(401);
    expect((await read_prompts_config())?.prompts).toEqual(CONFIG.prompts);
  });

  test('an empty controller config lists no prompts', async () => {
    const token = await authenticate('prompts-empty@canyonos.test');
    const { project_id } = await create_test_project(token, { name: 'Bare Project' });
    await seed_running_project(project_id, { prompts: {} });

    const res = await api.projects[project_id]!.prompts.get({ $headers: bearer(token) });

    expect(res.error).toBeNull();
    expect(res.data).toEqual({ project_id, items: [] });
    expect(await read_prompts_config()).toEqual({ prompts: {} });
  });
});
