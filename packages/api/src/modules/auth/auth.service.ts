import { config } from '@core/env';
import { badGateway, forbidden, unauthorized } from '@core/errors';
import { LOG_DOMAINS, logger } from '@core/logger';

import { authRepo } from './auth.repo';
import { jwtManager } from './lib/jwt';
import { generateNumericCode, hashCode, isFixedCodeSignIn } from './lib/otp';
import { UserStatusEnum } from './types';
import type { UserRow } from './auth.repo';
import type { AuthToken, User } from './types';

const authLogger = logger.child({ domain: LOG_DOMAINS.AUTH });

const toUser = (row: UserRow): User => ({
  id: row.id,
  email: row.email,
  name: row.name,
  company_id: row.companyId,
  status: (row.status as UserStatusEnum) ?? UserStatusEnum.PENDING,
  activated_at: row.activatedAt,
  locked_at: row.lockedAt,
  created_at: row.createdAt,
});

export const authService = {
  async requestChallenge(email: string): Promise<{ ok: true }> {
    const normalized = email.trim().toLowerCase();
    const existingUser = await authRepo.findUserByEmail(normalized);
    const user = existingUser ?? (await authRepo.createUser(normalized));
    const code = generateNumericCode(config.auth.codeLength);
    const expiresAt = new Date(Date.now() + config.auth.challengeTtlSeconds * 1000).toISOString();
    await authRepo.insertChallenge({
      userId: user.id,
      destination: normalized,
      purpose: 'login',
      codeHash: hashCode(code),
      expiresAt,
    });
    if (config.auth.mode !== 'email_otp') return { ok: true };

    const { sendEmail } = await import('@core/mailer');
    const result = await sendEmail({
      from: config.auth.emailFrom,
      to: normalized,
      subject: 'Your Canyon Code sign-in code',
      html: `<p>Your code is <strong>${code}</strong>. It expires in ${Math.round(
        config.auth.challengeTtlSeconds / 60
      )} minutes.</p>`,
    });
    if (!result.ok) {
      authLogger.error('verification code email failed to send', { email: normalized });
      throw badGateway('auth.email_delivery_failed', 'Could not send the verification code email');
    }
    return { ok: true };
  },

  async verifyChallenge(email: string, code: string): Promise<AuthToken> {
    const normalized = email.trim().toLowerCase();
    const fixed_code_sign_in = isFixedCodeSignIn(config.auth.mode, code);
    let user = await authRepo.findUserByEmail(normalized);
    if (!user && fixed_code_sign_in) user = await authRepo.createUser(normalized);
    if (!user) throw unauthorized('auth.invalid_credentials', 'Invalid code');
    if (user.status === UserStatusEnum.LOCKED) {
      throw forbidden('auth.account_locked', 'Account locked');
    }

    const now = new Date().toISOString();
    if (!fixed_code_sign_in) {
      const challenge = await authRepo.findValidChallenge(user.id, hashCode(code.trim()), now);
      if (!challenge) throw unauthorized('auth.invalid_credentials', 'Invalid or expired code');
      await authRepo.consumeChallenge(challenge.id, now);
    }

    if (user.status === UserStatusEnum.PENDING) {
      await authRepo.startOnboarding(user.id);
      user = { ...user, status: UserStatusEnum.ONBOARDING };
    }

    const token = await jwtManager.sign(user.id, { email: user.email });
    return { token, user: toUser(user) };
  },

  async getProfile(userId: string): Promise<User> {
    const user = await authRepo.findUserById(userId);
    if (!user) throw unauthorized('auth.user_not_found', 'User not found');
    return toUser(user);
  },
};
