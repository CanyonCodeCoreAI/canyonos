// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** The API key of the workflow groups `create_test_workflow` makes, unless it is given another. */
export const TEST_API_KEY = 'canyonos-api-e2e-key';

/** The machine's deploy key; `setup.ts` starts the API with its hash. */
export const TEST_DEPLOY_KEY = 'canyonos-api-e2e-deploy-key';

/** The sha256 of `key` in lowercase hex, as the CLI stores a key. */
export const hashApiKey = (key: string): string =>
  new Bun.CryptoHasher('sha256').update(key).digest('hex');
