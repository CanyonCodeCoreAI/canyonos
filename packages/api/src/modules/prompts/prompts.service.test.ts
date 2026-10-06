import { beforeEach, describe, expect, mock, test } from 'bun:test';

const store = new Map<string, string>();
const redis = { get: async (key: string) => store.get(key) ?? null };

interface Row {
  readonly name: string;
  readonly version: string;
  readonly content: string;
  readonly live: boolean;
  readonly created_at: Date;
}

/** The system_prompts table. */
let table: Row[] = [];
await mock.module('./prompts.repo', () => ({
  list_system_prompts: async () => table,
  lock_project: async () => {},
  insert_system_prompts: async () => {},
  set_live_system_prompt: async () => {},
}));

await mock.module('../canyonos/canyonos.redis', () => ({
  with_redis: (operation: (client: typeof redis) => Promise<unknown>) => operation(redis),
  assert_project_running: async () => {},
}));

const { get_prompt, list_prompts, load_prompts } = await import('./prompts.service');

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error
  );

const row = (
  n: number,
  created_at: string,
  live = false,
  version = `intent-parse-0000000${n}-v${n}`
) => ({
  name: 'intent-parse',
  version,
  content: `system ${n}`,
  live,
  created_at: new Date(created_at),
});

describe('stored prompt versions', () => {
  beforeEach(() => {
    table = [row(2, '2026-09-25T00:00:00Z'), row(3, '2026-09-20T00:00:00Z')];
  });

  test('with no live flag the highest n is live, even when an older n is dated later', async () => {
    const prompt = await get_prompt('p', 'intent-parse');
    expect(prompt.live.version).toBe('intent-parse-00000003-v3');
    expect(prompt.versions.map((stored) => stored.version)).toEqual([
      'intent-parse-00000003-v3',
      'intent-parse-00000002-v2',
    ]);
  });

  test('the version flagged live is live, and the listing carries it', async () => {
    table = [row(2, '2026-09-25T00:00:00Z', true), row(3, '2026-09-20T00:00:00Z')];

    expect(await list_prompts('p')).toEqual([
      {
        name: 'intent-parse',
        live: {
          version: 'intent-parse-00000002-v2',
          content: 'system 2',
          updated_at: '2026-09-25T00:00:00.000Z',
        },
      },
    ]);
  });

  test('a hash-like trailing segment is not a revision number', async () => {
    table = [
      row(3, '2026-09-20T00:00:00Z', false, 'intent-parse-a1b2c3d4-v3'),
      row(9, '2026-09-25T00:00:00Z', false, 'intent-parse-9abc0000'),
    ];

    expect((await get_prompt('p', 'intent-parse')).live.version).toBe('intent-parse-a1b2c3d4-v3');
  });

  test('no rows means no prompts, and a name with no rows is not found', async () => {
    table = [];

    expect(await list_prompts('p')).toEqual([]);
    expect(await rejection(get_prompt('p', 'intent-parse'))).toMatchObject({
      status: 404,
      code: 'prompts.prompt_not_found',
    });
  });
});

describe('prompts.yaml shapes', () => {
  test('malformed JSON is an invalid config, not an unreachable controller', async () => {
    store.set('prompts:yaml', '{"prompts": ');

    expect(await rejection(load_prompts('p'))).toMatchObject({
      status: 502,
      code: 'prompts.config_invalid',
    });
  });

  test('a prompts entry that is not a mapping is an invalid config', async () => {
    store.set('prompts:yaml', JSON.stringify({ prompts: ['intent-parse'] }));

    expect(await rejection(load_prompts('p'))).toMatchObject({
      status: 502,
      code: 'prompts.config_invalid',
    });
  });
});
