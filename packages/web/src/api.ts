import { edenTreaty } from '@elysiajs/eden';
import type { z } from 'zod';

import type { ForgeApi as ForgeApiType } from '@cc-forge/api/client';

import { authActions } from '@/modules/auth/auth.store';
import { webEnv } from '@/modules/core/lib/env';

const API_URL = webEnv.api.baseUrl;

export const forgePublicApi = edenTreaty<ForgeApiType>(API_URL);

const fetchWithAuth = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const token = authActions.getToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}) as typeof fetch;

export const forgeAuthApi = edenTreaty<ForgeApiType>(API_URL, { fetcher: fetchWithAuth });

export const forgeApi = forgePublicApi;

interface ErrorPayload {
  value: {
    error: string;
    message: string;
    request_id?: string;
    details?: { summary: string; message: string; path: string }[];
  };
}

export class ApiResponseError extends Error {
  readonly requestId?: string;
  readonly status?: number;
  readonly code?: string;
  constructor(message: string, requestId?: string, status?: number, code?: string) {
    super(message);
    this.name = 'ApiResponseError';
    this.requestId = requestId;
    this.status = status;
    this.code = code;
  }
}

type EdenResponse<T> = Promise<{ data: T; error: null } | { data: null; error: any }>;

/**
 * Generic API call wrapper. Extracts errors, optionally parses with Zod.
 *
 * @example
 * const data = await apiCall<MyType>(() => forgeApi.healthz.get());
 *
 * const profile = await apiCall<Profile>(
 *   () => forgeAuthApi.auth.profile.get(),
 *   profileSchema
 * );
 */
export async function apiCall<T>(
  request: () => EdenResponse<unknown>,
  schema?: z.ZodType
): Promise<T> {
  const result = await request();
  if (result.error) {
    const status = result.error.status as number | undefined;
    const error = result.error as ErrorPayload;
    const payload = error.value ?? ({} as Partial<ErrorPayload['value']>);
    let message = 'Something went wrong';
    if (payload.message) message = payload.message;
    if (payload.details?.[0]?.message) message = payload.details[0].message;
    throw new ApiResponseError(message, payload.request_id, status, payload.error);
  }
  if (schema) return schema.parse(result.data) as T;
  return result.data as T;
}
