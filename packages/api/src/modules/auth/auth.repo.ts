// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { eq, sql } from 'drizzle-orm';

import { db } from '@api/db/client';
import { users } from '@api/db/schema';

export type UserRow = typeof users.$inferSelect;

export const authRepo = {
  async hasUsers(): Promise<boolean> {
    const [row] = await db.select({ id: users.id }).from(users).limit(1);
    return row !== undefined;
  },

  async findUserByEmail(email: string): Promise<UserRow | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    return user;
  },

  async findUserById(id: string): Promise<UserRow | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return user;
  },

  /**
   * Inserts the account only while the table is empty; `undefined` means a user already existed.
   * NOT EXISTS alone lets two concurrent first registrations both insert under READ COMMITTED,
   * so the table lock serializes writers while leaving reads (login, status) unblocked.
   */
  async createFirstUser({
    email,
    passwordHash,
  }: {
    email: string;
    passwordHash: string;
  }): Promise<UserRow | undefined> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`LOCK TABLE ${users} IN SHARE ROW EXCLUSIVE MODE`);
      const [row] = await tx.execute<UserRow>(sql`
        INSERT INTO ${users} (email, password_hash)
        SELECT ${email}, ${passwordHash}
        WHERE NOT EXISTS (SELECT 1 FROM ${users})
        RETURNING id, email, password_hash, created_at AS "createdAt"
      `);
      return row;
    });
  },
};
