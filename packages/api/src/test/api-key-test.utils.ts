// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** The API key every E2E request sends; `setup.ts` starts the API with its hash. */
export const TEST_API_KEY = 'canyonos-api-e2e-key';

/** The control key every E2E request to /v1/workflow-groups sends; `setup.ts` starts the API with
 * its hash. */
export const TEST_CONTROL_KEY = 'canyonos-api-e2e-control-key';

/** The `CANYONOS_API_KEY_HASH` of `key`, as the CLI writes it. */
export const hashApiKey = (key: string): string =>
  new Bun.CryptoHasher('sha256').update(key).digest('hex');
