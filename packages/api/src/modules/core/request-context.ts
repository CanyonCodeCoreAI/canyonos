import { AsyncLocalStorage } from 'async_hooks';

interface RequestContext {
  request_id: string;
  client_ip: string;
}

const requestStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Bind the current async context to request metadata. Call once per HTTP request in onRequest.
 * Uses `enterWith` because Elysia hooks don't wrap handler execution (no `next()` pattern).
 * Safe in Bun: each HTTP fetch() runs in its own async context, so enterWith is request-scoped.
 */
export function enterRequestContext(requestId: string, clientIp: string): void {
  requestStorage.enterWith({ request_id: requestId, client_ip: clientIp });
}

export function getRequestContext(): RequestContext | undefined {
  return requestStorage.getStore();
}
