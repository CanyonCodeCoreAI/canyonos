import { Elysia, ValidationError } from 'elysia';
import { z } from 'zod';

import { logger } from './logger';
import { getRequestContext } from './request-context';

export const ApiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  request_id: z.string().optional(),
  details: z
    .array(z.object({ path: z.string(), summary: z.string(), message: z.string() }))
    .optional(),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;

type AppErrorCode = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502;

export interface AppErrorOptions {
  cause?: unknown;
  retryable?: boolean;
  meta?: Record<string, unknown>;
}

export class AppError extends Error {
  readonly retryable: boolean;
  readonly meta?: Record<string, unknown>;
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
  }
  toResponse() {
    return { error: this.code, message: this.message };
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
export const unprocessable = (code: string, message: string, opts?: AppErrorOptions) =>
  new AppError(422, code, message, opts);
export const tooManyRequests = (code: string, message: string, opts?: AppErrorOptions) =>
  new AppError(429, code, message, opts);
export const internalError = (code: string, message: string, opts?: AppErrorOptions) =>
  new AppError(500, code, message, opts);
export const badGateway = (code: string, message: string, opts?: AppErrorOptions) =>
  new AppError(502, code, message, opts);

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

export const errorPlugin = new Elysia({ name: 'plugin.error' })
  .guard({
    response: {
      400: ApiErrorSchema,
      401: ApiErrorSchema,
      403: ApiErrorSchema,
      404: ApiErrorSchema,
      409: ApiErrorSchema,
      422: ApiErrorSchema,
      429: ApiErrorSchema,
      500: ApiErrorSchema,
      502: ApiErrorSchema,
    },
  })
  .onError(({ code, error, status }) => {
    const request_id = getRequestContext()?.request_id;
    if (code === 'NOT_FOUND') {
      return status(404, { error: 'not_found', message: 'Resource not found', request_id });
    }
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
