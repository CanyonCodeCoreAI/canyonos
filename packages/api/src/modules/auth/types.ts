// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const UserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  created_at: z.string(),
});
export type User = z.infer<typeof UserSchema>;

export const LoginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const RegisterSchema = LoginSchema.extend({ password_confirmation: z.string() }).refine(
  (input) => input.password === input.password_confirmation,
  { message: 'Passwords do not match', path: ['password_confirmation'] }
);
export type RegisterInput = z.infer<typeof RegisterSchema>;

export const AuthStatusSchema = z.object({ has_users: z.boolean() });
export type AuthStatus = z.infer<typeof AuthStatusSchema>;

export const AuthTokenSchema = z.object({
  token: z.string(),
  user: UserSchema,
});
export type AuthToken = z.infer<typeof AuthTokenSchema>;
