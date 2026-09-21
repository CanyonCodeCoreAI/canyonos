const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (TRUE_VALUES.has(v)) return true;
  if (FALSE_VALUES.has(v)) return false;
  return fallback;
};

const parseInteger = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

const parseNumber = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const parseDuration = (value: string | undefined, fallbackSeconds: number): number => {
  if (value === undefined) return fallbackSeconds;
  const match = value.trim().match(/^(\d+)(ms|s|m|h|d)?$/i);
  if (!match) return fallbackSeconds;
  const n = parseInt(match[1]!, 10);
  const unit = (match[2] ?? 's').toLowerCase();
  switch (unit) {
    case 'ms':
      return Math.round(n / 1000);
    case 's':
      return n;
    case 'm':
      return n * 60;
    case 'h':
      return n * 3600;
    case 'd':
      return n * 86400;
    default:
      return fallbackSeconds;
  }
};

const requireEnv = (key: string): string => {
  const value = Bun.env[key];
  if (!value) throw new Error(`Missing required env: ${key}`);
  return value;
};

export const helpers = {
  parseBoolean,
  parseInteger,
  parseNumber,
  parseDuration,
  requireEnv,
};
