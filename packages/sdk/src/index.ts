// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import createFetchClient from 'openapi-fetch';

import type { paths } from './schema.js';

export type { components, operations, paths } from './schema.js';

/** A client for the CanyonOS API at `baseUrl`, typed by its routes, that sends `headers` with every request. */
export function createClient(baseUrl: string, headers?: HeadersInit) {
  return createFetchClient<paths>({ baseUrl, headers });
}
