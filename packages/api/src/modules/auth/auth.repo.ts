import { and, eq, gt, isNull } from 'drizzle-orm';

import { db } from '@api/db/client';
import { authChallenges, users } from '@api/db/schema';
import { internalError } from '@core/errors';

export type UserRow = typeof users.$inferSelect;
export type ChallengeRow = typeof authChallenges.$inferSelect;
export type NewChallenge = typeof authChallenges.$inferInsert;

export const authRepo = {
  async findUserByEmail(email: string): Promise<UserRow | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    return user;
  },

  async findUserById(id: string): Promise<UserRow | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return user;
  },

  async createUser(email: string): Promise<UserRow> {
    const [row] = await db.insert(users).values({ email }).returning();
    if (!row) throw internalError('auth.user_create_failed', 'Failed to create user');
    return row;
  },

  async insertChallenge(values: NewChallenge): Promise<ChallengeRow> {
    const [row] = await db.insert(authChallenges).values(values).returning();
    if (!row) throw internalError('auth.challenge_create_failed', 'Failed to create challenge');
    return row;
  },

  async findValidChallenge(
    userId: string,
    codeHash: string,
    nowIso: string
  ): Promise<ChallengeRow | undefined> {
    const [challenge] = await db
      .select()
      .from(authChallenges)
      .where(
        and(
          eq(authChallenges.userId, userId),
          eq(authChallenges.codeHash, codeHash),
          isNull(authChallenges.consumedAt),
          gt(authChallenges.expiresAt, nowIso)
        )
      )
      .limit(1);
    return challenge;
  },

  async consumeChallenge(id: string, nowIso: string): Promise<void> {
    await db.update(authChallenges).set({ consumedAt: nowIso }).where(eq(authChallenges.id, id));
  },

  async startOnboarding(id: string): Promise<void> {
    await db.update(users).set({ status: 'ONBOARDING' }).where(eq(users.id, id));
  },
};
