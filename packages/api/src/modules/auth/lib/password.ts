// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

// Argon2id at 64 MiB, t=2, p=1: above the OWASP Password Storage Cheat Sheet minimum.
const ARGON2ID = { algorithm: 'argon2id', memoryCost: 65536, timeCost: 2 } as const;

export const hashPassword = (password: string): Promise<string> =>
  Bun.password.hash(password, ARGON2ID);

export const verifyPassword = (password: string, hash: string): Promise<boolean> =>
  Bun.password.verify(password, hash);

// Verified against when no account matches, so an unknown email costs as long as a wrong password.
export const DUMMY_HASH = await hashPassword(crypto.randomUUID());
