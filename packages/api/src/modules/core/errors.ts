// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Elysia, ValidationError } from 'elysia';
import { z } from 'zod';

import { logger } from './logger';
import { current_request } from './request-context';

export const ApiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  request_id: z.string().optional(),
  details: z
    .array(z.object({ path: z.string(), summary: z.string(), message: z.string() }))
    .optional(),
  findings: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;

type AppErrorCode = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502 | 503 | 504;

/** What an error answer carries besides its code and message, such as the findings of a check. */
export interface AppErrorExtra {
  findings?: string[];
  warnings?: string[];
}

export interface AppErrorOptions {
  cause?: unknown;
  retryable?: boolean;
  meta?: Record<string, unknown>;
  extra?: AppErrorExtra;
}

export class AppError extends Error {
  readonly retryable: boolean;
  readonly meta?: Record<string, unknown>;
  readonly extra?: AppErrorExtra;
  constructor(
    readonly status: AppErrorCode,
    readonly code: string,
    message: string,
    options?: AppErrorOptions
  ) {
    super(message, { cause: options?.cause });
    this.name = 'AppError';
    this.retryable = options?.retryable ?? true;
    this.meta = options?.meta;
    this.extra = options?.extra;
  }
  toResponse() {
    return { error: this.code, message: this.message, ...this.extra };
  }
}

export const badRequest = (code: string, message: string, opts?: AppErrorOptions) =>
  new AppError(400, code, message, opts);
export const unauthorized = (code: string, message: string, opts?: AppErrorOptions) =>
  new AppError(401, code, message, opts);
export const forbidden = (code: string, message: string, opts?: AppErrorOptions) =>
  new AppError(403, code, message, opts);
export const notFound = (code: string, message: string, opts?: AppErrorOptions) =>
  new AppError(404, code, message, opts);
export const conflict = (code: string, message: string, opts?: AppErrorOptions) =>
  new AppError(409, code, message, opts);
export const payloadTooLarge = (code: string, message: string, opts?: AppErrorOptions) =>
  new AppError(413, code, message, opts);
export const unprocessable = (code: string, message: string, opts?: AppErrorOptions) =>
  new AppError(422, code, message, opts);
export const tooManyRequests = (code: string, message: string, opts?: AppErrorOptions) =>
  new AppError(429, code, message, opts);
export const internalError = (code: string, message: string, opts?: AppErrorOptions) =>
  new AppError(500, code, message, opts);
export const badGateway = (code: string, message: string, opts?: AppErrorOptions) =>
  new AppError(502, code, message, opts);
export const serviceUnavailable = (code: string, message: string, opts?: AppErrorOptions) =>
  new AppError(503, code, message, opts);
export const gatewayTimeout = (code: string, message: string, opts?: AppErrorOptions) =>
  new AppError(504, code, message, opts);

/** The answer to a request a request hook refuses with `error`. Elysia answers an error thrown
 * in `onRequest` with its `toResponse()` and status 200, past the error handler, so the hook
 * returns this instead. */
export function early_refusal(set: { status?: number | string }, error: AppError) {
  set.status = error.status;
  return { ...error.toResponse(), request_id: current_request()?.request_id };
}

export const wrapError = (
  error: unknown,
  defaultCode = 'internal_error',
  defaultMessage = 'Unexpected error'
): AppError => {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message : defaultMessage;
  return internalError(defaultCode, message);
};

export const isNonRetryableError = (error: unknown): error is AppError =>
  error instanceof AppError && !error.retryable;

/** The AppError an error a library throws answers as, or null when it does not know it. */
export type ErrorTranslation = (error: unknown) => AppError | null;

const translations: ErrorTranslation[] = [];

/** Has the error plugin answer each error `translation` knows as the AppError it gives; the
 * database module adds one for a lost connection. */
export function translate_errors(translation: ErrorTranslation): void {
  translations.push(translation);
}

const translated = (error: unknown): unknown => {
  if (error instanceof AppError) return error;
  for (const translation of translations) {
    const known = translation(error);
    if (known) return known;
  }
  return error;
};

export const errorPlugin = new Elysia({ name: 'plugin.error' })
  .guard({
    response: {
      400: ApiErrorSchema,
      401: ApiErrorSchema,
      403: ApiErrorSchema,
      404: ApiErrorSchema,
      409: ApiErrorSchema,
      413: ApiErrorSchema,
      422: ApiErrorSchema,
      429: ApiErrorSchema,
      500: ApiErrorSchema,
      502: ApiErrorSchema,
      503: ApiErrorSchema,
      504: ApiErrorSchema,
    },
  })
  .onError(({ code, error: thrown, status }) => {
    const request_id = current_request()?.request_id;
    if (code === 'NOT_FOUND') {
      return status(404, { error: 'not_found', message: 'Resource not found', request_id });
    }
    const error = translated(thrown);
    if (error instanceof AppError) {
      if (error.status !== 401) {
        logger.error('App error', {
          error,
          error_code: error.code,
          status: error.status,
          meta: error.meta,
        });
      }
      return status(error.status, { ...error.toResponse(), request_id });
    }
    if (error instanceof ValidationError) {
      const details = error.all.map((e) => ({
        summary: (e as { summary: string }).summary,
        message: (e as { message: string }).message,
        path: (e as { path: string }).path,
      }));
      logger.warn('Validation error', { details });
      return status(422, {
        error: 'validation_error',
        message: 'Validation failed',
        details,
        request_id,
      });
    }
    logger.error('Unhandled error', { error });
    return status(500, { error: 'internal_error', message: 'Internal server error', request_id });
  })
  .as('global');
