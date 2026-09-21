import { sleep } from 'bun';
import { beforeAll } from 'bun:test';
import type { edenTreaty } from '@elysiajs/eden';

import { startApi } from '@api/app';
import type { ForgeApi } from '@api/app';
import { config } from '@core/env';

import { createApi } from './test.utils';

export let api: ReturnType<typeof edenTreaty<ForgeApi>>;

let setupPromise: Promise<void> | null = null;

async function startServers(): Promise<void> {
  const server = await startApi({ host: config.app.host, port: config.app.port });
  process.on('beforeExit', async () => {
    await server.stop();
  });
  await sleep(200);
  api = createApi();
}

export function setupE2ETests() {
  beforeAll(async () => {
    if (!setupPromise) setupPromise = startServers();
    await setupPromise;
  });
}
