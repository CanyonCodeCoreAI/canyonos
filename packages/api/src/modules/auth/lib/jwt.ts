import { jwtVerify, SignJWT } from 'jose';

import { config } from '@core/env';
import { unauthorized } from '@core/errors';

export interface TokenPayload {
  sub: string;
  email: string;
  jti?: string;
  exp?: number;
}

const secret = new TextEncoder().encode(config.auth.jwtSecret);

export const jwtManager = {
  async sign(userId: string, extra: Omit<TokenPayload, 'sub' | 'jti' | 'exp'>): Promise<string> {
    return new SignJWT({ email: extra.email })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer(config.auth.jwtIssuer)
      .setAudience(config.auth.jwtAudience)
      .setExpirationTime(`${config.auth.jwtTtlSeconds}s`)
      .setJti(crypto.randomUUID())
      .sign(secret);
  },
  async verify(token: string): Promise<TokenPayload> {
    try {
      const { payload } = await jwtVerify(token, secret, {
        issuer: config.auth.jwtIssuer,
        audience: config.auth.jwtAudience,
      });
      return payload as unknown as TokenPayload;
    } catch {
      throw unauthorized('auth.invalid_token', 'Invalid or expired token');
    }
  },
};
