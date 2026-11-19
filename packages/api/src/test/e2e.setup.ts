// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeAll } from 'bun:test';
import type { edenTreaty } from '@elysiajs/eden';

import { start_api } from '@api/app';
import type { CanyonosApi } from '@api/app';
import { config } from '@core/env';

import { createApi, until_ready } from './test.utils';

export let api: ReturnType<typeof edenTreaty<CanyonosApi>>;

let setupPromise: Promise<void> | null = null;

async function startServers(): Promise<void> {
  const running = start_api({ host: config.app.host, port: config.app.port });
  process.on('beforeExit', async () => {
    await running.stop();
  });
  // The API listens before it migrates: wait until it serves every route.
  await until_ready(config.app.apiUrl);
  api = createApi();
}

export function setupE2ETests() {
  beforeAll(async () => {
    if (!setupPromise) setupPromise = startServers();
    await setupPromise;
  }, 35_000);
}
