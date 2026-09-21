import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

import { LOG_DOMAINS, logger } from './logger';

export interface TraceContext {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  service_name: string;
}

const serviceName = Bun.env.SERVICE_NAME ?? 'cc-forge-api';
const traceStorage = new AsyncLocalStorage<TraceContext>();

function buildTraceContext(ctx?: Partial<TraceContext>): TraceContext {
  const parent = traceStorage.getStore();
  return {
    trace_id: ctx?.trace_id ?? parent?.trace_id ?? randomUUID(),
    span_id: ctx?.span_id ?? randomUUID(),
    parent_span_id: ctx?.parent_span_id ?? parent?.span_id,
    service_name: ctx?.service_name ?? parent?.service_name ?? serviceName,
  };
}

export const getTraceContext = (): TraceContext | undefined => traceStorage.getStore();

export const enterTraceContext = (ctx?: Partial<TraceContext>): void => {
  traceStorage.enterWith(buildTraceContext(ctx));
};

export function withTraceContext<T>(ctx: Partial<TraceContext>, fn: () => T): T {
  return traceStorage.run(buildTraceContext(ctx), fn);
}

const telemetryLogger = logger.child({ domain: LOG_DOMAINS.TELEMETRY });

const describeError = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? 'unknown error';
  } catch {
    return 'unserializable error';
  }
};

export function record<T>(
  name: string,
  fn: () => T | Promise<T>,
  attributes?: Record<string, unknown>
): T | Promise<T> {
  const spanCtx = buildTraceContext();
  const start = performance.now();
  const finish = (error?: unknown) => {
    const duration_ms = Math.round((performance.now() - start) * 100) / 100;
    const log = {
      _span: true,
      span_name: name,
      ...spanCtx,
      duration_ms,
      status: error ? 'error' : 'ok',
      ...attributes,
      ...(error ? { error: describeError(error) } : {}),
    };
    if (error) telemetryLogger.error(`span:${name}`, log);
    else telemetryLogger.debug(`span:${name}`, log);
  };
  try {
    const result = traceStorage.run(spanCtx, fn);
    if (result instanceof Promise) {
      return result.then(
        (v) => {
          finish();
          return v;
        },
        (e) => {
          finish(e);
          throw e;
        }
      );
    }
    finish();
    return result;
  } catch (error) {
    finish(error);
    throw error;
  }
}

export function emitMetric(name: string, value: number, tags?: Record<string, unknown>): void {
  const ctx = traceStorage.getStore();
  telemetryLogger.info(`metric:${name}`, {
    _metric: true,
    metric_name: name,
    metric_value: value,
    trace_id: ctx?.trace_id,
    service_name: ctx?.service_name ?? serviceName,
    ...tags,
  });
}
