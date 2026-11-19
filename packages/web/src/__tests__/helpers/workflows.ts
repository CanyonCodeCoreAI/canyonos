// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Route } from '@playwright/test';

export const apiBaseUrl = process.env.VITE_API_URL ?? 'http://localhost:3000';

/** A second API on the same database with no API key, started by Playwright. */
export const noAuthApiBaseUrl = 'http://localhost:3010';

/**
 * The API's error answer (ApiErrorSchema in packages/api/src/modules/core/errors.ts), which the
 * SDK exports no type for.
 */
export interface ApiErrorBody {
  readonly error: string;
  readonly message: string;
  readonly request_id?: string;
  readonly details?: readonly { path: string; summary: string; message: string }[];
  readonly findings?: readonly string[];
  readonly warnings?: readonly string[];
}

export async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

export async function failJson(route: Route, message = 'Controlled test failure'): Promise<void> {
  await fulfillJson(route, { error: 'test.failure', message } satisfies ApiErrorBody, 500);
}
