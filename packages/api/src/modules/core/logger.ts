import pino from 'pino';

import { getRequestContext } from './request-context';

interface LogFields {
  [key: string]: unknown;
}

interface ChildLogger {
  debug: (message: string, fields?: LogFields) => void;
  info: (message: string, fields?: LogFields) => void;
  warn: (message: string, fields?: LogFields) => void;
  error: (message: string, fields?: LogFields) => void;
  child: (baseFields: LogFields) => ChildLogger;
}

export const LOG_DOMAINS = {
  HTTP: '[HTTP]',
  DB: '[DB]',
  AUTH: '[Auth]',
  COMPANY: '[Company]',
  DEPLOY: '[Deploy]',
  QUEUE: '[Queue]',
  MAIL: '[Mail]',
  WORKER: '[Worker]',
  TELEMETRY: '[Telemetry]',
  ERROR: '[Error]',
} as const;

const isTestEnv = Bun.env.NODE_ENV === 'test';
const isDevEnv = Bun.env.NODE_ENV === 'development' || Bun.env.NODE_ENV === undefined;

let _pinoLogger: pino.Logger | null = null;

const createPrettyTransport = (): pino.TransportSingleOptions => ({
  target: 'pino-pretty',
  options: {
    colorize: true,
    ignore: 'pid,hostname,service_name,domain',
    translateTime: 'HH:MM:ss.l',
    messageFormat: '{msg}',
  },
});

function createPinoInstance(): pino.Logger {
  const stdoutLevel = (Bun.env.LOG_LEVEL || 'info') as pino.LevelWithSilentOrString;
  return pino(
    {
      level: stdoutLevel,
      base: { service_name: Bun.env.SERVICE_NAME ?? 'canyonos-api' },
      mixin: () => {
        const reqCtx = getRequestContext();
        return reqCtx ? { request_id: reqCtx.request_id, client_ip: reqCtx.client_ip } : {};
      },
      formatters: { level: (label) => ({ level: label }) },
      serializers: { error: pino.stdSerializers.err },
    },
    isDevEnv && !isTestEnv ? pino.transport(createPrettyTransport()) : undefined
  );
}

export function initLogger(): void {
  if (isTestEnv) return;
  _pinoLogger = createPinoInstance();
}

function getPinoLogger(): pino.Logger {
  if (isTestEnv) return createPinoInstance();
  if (_pinoLogger) return _pinoLogger;
  _pinoLogger = createPinoInstance();
  return _pinoLogger;
}

const createChildLogger = (baseFields: LogFields): ChildLogger => {
  const domain = baseFields.domain as string | undefined;
  const prefix = (msg: string) => (domain ? `${domain} ${msg}` : msg);
  let cachedParent: pino.Logger | null = null;
  let pinoChild: pino.Logger | null = null;
  const getChild = () => {
    const current = getPinoLogger();
    if (current !== cachedParent) {
      cachedParent = current;
      pinoChild = current.child(baseFields);
    }
    return pinoChild!;
  };
  return {
    debug: (msg, fields) => getChild().debug(fields || {}, prefix(msg)),
    info: (msg, fields) => getChild().info(fields || {}, prefix(msg)),
    warn: (msg, fields) => getChild().warn(fields || {}, prefix(msg)),
    error: (msg, fields) => getChild().error(fields || {}, prefix(msg)),
    child: (childFields) => createChildLogger({ ...baseFields, ...childFields }),
  };
};

export const logger = {
  debug: (m: string, f?: LogFields) => getPinoLogger().debug(f || {}, m),
  info: (m: string, f?: LogFields) => getPinoLogger().info(f || {}, m),
  warn: (m: string, f?: LogFields) => getPinoLogger().warn(f || {}, m),
  error: (m: string, f?: LogFields) => getPinoLogger().error(f || {}, m),
  child: (fields: LogFields): ChildLogger => createChildLogger(fields),
};
