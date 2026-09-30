import { eq } from 'drizzle-orm';

import { db } from '@api/db/client';
import { companies, users } from '@api/db/schema';
import { internalError } from '@core/errors';

export type JoinCompanyResult = 'ok' | 'not_onboarding' | 'company_not_found';
export type CreateCompanyResult = 'ok' | 'not_onboarding';

export const onboardingRepo = {
  async joinCompany(userId: string, companyId: string): Promise<JoinCompanyResult> {
    return db.transaction(async (tx) => {
      const [user] = await tx
        .select({ status: users.status })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (user?.status !== 'ONBOARDING') return 'not_onboarding';

      const [company] = await tx
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      if (!company) return 'company_not_found';

      await tx
        .update(users)
        .set({ companyId, status: 'ACTIVE', activatedAt: new Date().toISOString() })
        .where(eq(users.id, userId));
      return 'ok';
    });
  },

  async createAndJoinCompany(userId: string, name: string): Promise<CreateCompanyResult> {
    return db.transaction(async (tx) => {
      const [user] = await tx
        .select({ status: users.status })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (user?.status !== 'ONBOARDING') return 'not_onboarding';

      const [company] = await tx.insert(companies).values({ name }).returning({ id: companies.id });
      if (!company) {
        throw internalError('onboarding.company_create_failed', 'Failed to create company');
      }

      await tx
        .update(users)
        .set({ companyId: company.id, status: 'ACTIVE', activatedAt: new Date().toISOString() })
        .where(eq(users.id, userId));
      return 'ok';
    });
  },
};
