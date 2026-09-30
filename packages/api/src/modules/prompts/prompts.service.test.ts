import { beforeEach, describe, expect, mock, test } from 'bun:test';

const store = new Map<string, string>();
let writes = 0;
let watched_at: number | null = null;
let queued: [string, string][] = [];
let on_read: (() => void) | null = null;

/** Another client's write; it bumps the counter WATCH snapshots so EXEC sees the conflict. */
function write(key: string, value: string) {
  store.set(key, value);
  writes += 1;
}

const redis = {
  get: async (key: string) => {
    const value = store.get(key) ?? null;
    on_read?.();
    return value;
  },
  send: async (command: string, args: string[]) => {
    switch (command) {
      case 'WATCH':
        watched_at = writes;
        return 'OK';
      case 'MULTI':
        queued = [];
        return 'OK';
      case 'SET':
        queued.push([args[0]!, args[1]!]);
        return 'QUEUED';
      case 'EXEC': {
        const clean = watched_at === writes;
        if (clean) queued.forEach(([key, value]) => write(key, value));
        watched_at = null;
        return clean ? ['OK'] : null;
      }
      default:
        throw new Error(`Unexpected command ${command}`);
    }
  },
};

await mock.module('../canyonos/canyonos.redis', () => ({
  with_redis: (operation: (client: typeof redis) => Promise<unknown>) => operation(redis),
  assert_project_running: async () => {},
}));

const { get_prompts, save_prompt } = await import('./prompts.service');

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error
  );

const version = (n: number, updated_at: string, system = `system ${n}`) => ({
  version: `intent-parse-0000000${n}-${n}`,
  updated_at,
  system,
  user: '{query}',
});

const stored_versions = () =>
  JSON.parse(store.get('prompts:config')!).prompts['intent-parse'].map(
    (entry: { version: string }) => entry.version
  );

describe('prompt versions', () => {
  beforeEach(() => {
    on_read = null;
    store.set(
      'prompts:config',
      JSON.stringify({
        prompts: {
          'intent-parse': [version(3, '2026-09-20T00:00:00Z'), version(2, '2026-09-25T00:00:00Z')],
        },
      })
    );
  });

  test('the highest n is current, even when an older n is dated later', async () => {
    const { items } = await get_prompts('p');
    expect(items.map((item) => item.version)).toEqual(['intent-parse-00000003-3']);
  });

  test('saving appends the next version and it becomes current', async () => {
    const saved = await save_prompt('p', 'intent-parse', { system: 'edited', user: '{query}' });

    expect(saved.version).toMatch(/^intent-parse-[0-9a-f]{8}-4$/);
    expect(stored_versions()).toEqual([
      'intent-parse-00000003-3',
      'intent-parse-00000002-2',
      saved.version,
    ]);
    const { items } = await get_prompts('p');
    expect(items[0]?.system).toBe('edited');
  });

  test('a hash-like trailing segment is not a revision number', async () => {
    store.set(
      'prompts:config',
      JSON.stringify({
        prompts: {
          'intent-parse': [
            { ...version(3, '2026-09-20T00:00:00Z'), version: 'intent-parse-a1b2c3d4-3' },
            { ...version(9, '2026-09-25T00:00:00Z'), version: 'intent-parse-9abc0000' },
          ],
        },
      })
    );

    const { items } = await get_prompts('p');
    expect(items.map((item) => item.version)).toEqual(['intent-parse-a1b2c3d4-3']);

    const saved = await save_prompt('p', 'intent-parse', { system: 'edited', user: '{query}' });
    expect(saved.version).toMatch(/^intent-parse-[0-9a-f]{8}-4$/);
  });

  test('a write that lands between the read and the commit is retried on top of it', async () => {
    let interfered = false;
    on_read = () => {
      if (interfered) return;
      interfered = true;
      const config = JSON.parse(store.get('prompts:config')!);
      config.prompts['intent-parse'].push(version(4, '2026-09-26T00:00:00Z'));
      write('prompts:config', JSON.stringify(config));
    };

    const saved = await save_prompt('p', 'intent-parse', { system: 'edited', user: '{query}' });

    expect(saved.version).toMatch(/-5$/);
    expect(stored_versions()).toEqual([
      'intent-parse-00000003-3',
      'intent-parse-00000002-2',
      'intent-parse-00000004-4',
      saved.version,
    ]);
  });

  test('a key that keeps changing is reported as a conflict', async () => {
    on_read = () => write('prompts:config', store.get('prompts:config')!);

    expect(
      await rejection(save_prompt('p', 'intent-parse', { system: 'edited', user: '{query}' }))
    ).toMatchObject({ status: 409, code: 'prompts.save_conflict' });
    expect(stored_versions()).toEqual(['intent-parse-00000003-3', 'intent-parse-00000002-2']);
  });

  test('an unknown prompt is not found', async () => {
    expect(await rejection(save_prompt('p', 'missing', { system: 's', user: 'u' }))).toMatchObject({
      status: 404,
      code: 'prompts.prompt_not_found',
    });
  });
});

describe('prompts config shapes', () => {
  test('entries that are not version lists expose no prompt', async () => {
    store.set(
      'prompts:config',
      JSON.stringify({
        prompts: { database: 'StateDB', a: {}, 'intent-parse': [version(1, null as never)] },
      })
    );

    const { items } = await get_prompts('p');
    expect(items.map((item) => item.name)).toEqual(['intent-parse']);
  });

  test('a missing key means no prompts', async () => {
    store.delete('prompts:config');

    const { items } = await get_prompts('p');
    expect(items).toEqual([]);
  });

  test('malformed JSON is an invalid config, not an unreachable controller', async () => {
    store.set('prompts:config', '{"prompts": ');

    expect(await rejection(get_prompts('p'))).toMatchObject({
      status: 502,
      code: 'prompts.config_invalid',
    });
  });

  test('a prompts entry that is not a mapping is an invalid config', async () => {
    store.set('prompts:config', JSON.stringify({ prompts: ['intent-parse'] }));

    expect(await rejection(get_prompts('p'))).toMatchObject({
      status: 502,
      code: 'prompts.config_invalid',
    });
  });
});
