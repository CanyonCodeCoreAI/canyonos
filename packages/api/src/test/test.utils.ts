// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { edenTreaty } from '@elysiajs/eden';

import type { CanyonosApi } from '@api/app';
import { config } from '@core/env';

const READY_TIMEOUT_MS = 30_000;
const POLL_MS = 200;

export const createApi = (): ReturnType<typeof edenTreaty<CanyonosApi>> =>
  edenTreaty<CanyonosApi>(config.app.apiUrl);

/** Resolves once `<url><path>` answers 200, polling until `timeout_ms` passes. */
export async function until_answers(
  url: string,
  path: '/healthz' | '/readyz',
  timeout_ms = READY_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeout_ms;
  while (Date.now() < deadline) {
    const ok = await fetch(`${url}${path}`)
      .then((response) => response.ok)
      .catch(() => false);
    if (ok) return;
    await Bun.sleep(POLL_MS);
  }
  throw new Error(`${url}${path} did not answer 200 within ${timeout_ms / 1000} s`);
}

/** Resolves once the API at `url` is ready: its database migrated and answering. */
export const until_ready = (url: string) => until_answers(url, '/readyz');
