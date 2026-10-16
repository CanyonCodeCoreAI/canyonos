// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { forbidden, unauthorized } from '@core/errors';

import { authRepo } from './auth.repo';
import { jwtManager } from './lib/jwt';
import { DUMMY_HASH, hashPassword, verifyPassword } from './lib/password';
import type { UserRow } from './auth.repo';
import type { AuthStatus, AuthToken, User } from './types';

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const registrationClosed = () =>
  forbidden('auth.registration_closed', 'Registration is closed; sign in with an existing account');

const toUser = (row: UserRow): User => ({
  id: row.id,
  email: row.email,
  created_at: row.createdAt,
});

const issueToken = async (row: UserRow): Promise<AuthToken> => ({
  token: await jwtManager.sign(row.id, { email: row.email }),
  user: toUser(row),
});

export const authService = {
  async status(): Promise<AuthStatus> {
    return { has_users: await authRepo.hasUsers() };
  },

  async register(email: string, password: string): Promise<AuthToken> {
    if (await authRepo.hasUsers()) throw registrationClosed();
    const created = await authRepo.createFirstUser({
      email: normalizeEmail(email),
      passwordHash: await hashPassword(password),
    });
    if (!created) throw registrationClosed();
    return issueToken(created);
  },

  async login(email: string, password: string): Promise<AuthToken> {
    const user = await authRepo.findUserByEmail(normalizeEmail(email));
    const valid = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !valid) {
      throw unauthorized('auth.invalid_credentials', 'Invalid email or password');
    }
    return issueToken(user);
  },

  async getProfile(userId: string): Promise<User> {
    const user = await authRepo.findUserById(userId);
    if (!user) throw unauthorized('auth.user_not_found', 'User not found');
    return toUser(user);
  },
};
