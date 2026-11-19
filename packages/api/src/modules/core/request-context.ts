// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestScope {
  request_id: string;
  client_ip: string;
  /** `performance.now()` when the request arrived. */
  started_at: number;
}

const request_storage = new AsyncLocalStorage<RequestScope>();
const scopes = new WeakMap<Request, RequestScope>();

function client_ip(request: Request): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown'
  );
}

/**
 * Opens the request's scope: its id (the caller's `x-request-id` or `cf-ray`, else a new one),
 * client address and arrival time. Elysia hooks do not wrap the handler, so `enterWith` binds it
 * to the async context Bun gives each request, and the WeakMap keeps it for hooks that run after
 * that context ends. Call it in the first `onRequest`, before any guard that may refuse.
 */
export function begin_request(request: Request): RequestScope {
  const scope: RequestScope = {
    request_id:
      request.headers.get('x-request-id') ?? request.headers.get('cf-ray') ?? Bun.randomUUIDv7(),
    client_ip: client_ip(request),
    started_at: performance.now(),
  };
  scopes.set(request, scope);
  request_storage.enterWith(scope);
  return scope;
}

/** The scope `begin_request` opened for `request`, also after its async context ended. */
export function request_timing(request: Request): RequestScope | undefined {
  return scopes.get(request);
}

/** The scope of the request this code runs for, if any. */
export function current_request(): RequestScope | undefined {
  return request_storage.getStore();
}
