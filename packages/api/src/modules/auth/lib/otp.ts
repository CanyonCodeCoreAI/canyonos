import { createHash, randomInt } from 'crypto';

import { badRequest } from '@core/errors';
import type { AuthMode } from '@core/env';

export const FIXED_LOGIN_CODE = '111111';

export const generateNumericCode = (length: number): string => {
  if (length <= 0) throw badRequest('auth.otp_invalid_length', 'Code length must be > 0');
  const bound = 10 ** length;
  return randomInt(bound).toString().padStart(length, '0');
};

export const hashCode = (code: string): string => createHash('sha256').update(code).digest('hex');

export const isFixedCodeSignIn = (mode: AuthMode, code: string): boolean =>
  mode === 'fixed_code' && code === FIXED_LOGIN_CODE;
