import { eq, sql } from 'drizzle-orm';

import { config } from '@core/env';
import { internalError } from '@core/errors';
import { LOG_DOMAINS, logger } from '@core/logger';

import { UserStatusEnum } from '../modules/auth/types';
import { db } from './client';
import { companies, deploySetups, users } from './schema';
import { SEED_ADVISORY_LOCK_KEY, seedDevTelemetry } from './seed-telemetry';

const seedLogger = logger.child({ domain: LOG_DOMAINS.DB });

const DEMO_COMPANY_NAME = 'Canyon Code Demo';
const DEMO_USER_EMAIL = 'e2e@cc-forge.test';

type SeedTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const MOCK_DEPLOY_SETUP = {
  name: 'Test AWS',
  provider: 'AWS',
  region: 'us-east-1',
  ami_id: 'ami-0123456789abcdef0',
  instance_type: 't3.micro',
  subnet_id: 'TODO',
  security_group_ids: 'sg-0123456789abcdef0',
  ssh_user: 'ubuntu',
  ssh_private_key_path: '~/.ssh/ventis.pem',
} as const;

/** Find or create the company used by local and E2E environments. */
async function ensureDemoCompany(tx: SeedTx, existingCompanyId: string | null): Promise<string> {
  if (existingCompanyId) return existingCompanyId;
  const [existing] = await tx
    .select()
    .from(companies)
    .where(eq(companies.name, DEMO_COMPANY_NAME))
    .limit(1);
  if (existing) return existing.id;
  const [created] = await tx.insert(companies).values({ name: DEMO_COMPANY_NAME }).returning();
  if (!created) throw internalError('seed.company_failed', 'Failed to seed demo company');
  return created.id;
}

/** Ensure the deterministic E2E user is active and attached to the demo company. */
async function ensureDemoUser(tx: SeedTx, companyId: string): Promise<string> {
  await tx
    .insert(users)
    .values({ email: DEMO_USER_EMAIL, status: UserStatusEnum.ACTIVE, companyId })
    .onConflictDoUpdate({
      target: users.email,
      set: { status: UserStatusEnum.ACTIVE, companyId },
    });
  const [user] = await tx.select().from(users).where(eq(users.email, DEMO_USER_EMAIL)).limit(1);
  if (!user) throw internalError('seed.user_failed', 'Failed to seed demo user');
  return user.id;
}

/** Ensure the seeded deployment target exists for dashboard E2E coverage. */
async function ensureMockDeploySetup(
  tx: SeedTx,
  companyId: string,
  createdBy: string
): Promise<void> {
  const [existing] = await tx
    .select()
    .from(deploySetups)
    .where(eq(deploySetups.company_id, companyId))
    .limit(1);
  if (existing) return;
  await tx
    .insert(deploySetups)
    .values({ ...MOCK_DEPLOY_SETUP, company_id: companyId, created_by: createdBy });
  seedLogger.info('Seeded Test AWS deploy setup', { companyId });
}

/** Seed opt-in development data while remaining a no-op in production. */
export async function seedDevData(): Promise<void> {
  if (config.isProduction || !config.seed.devData) {
    seedLogger.info('Dev seed disabled — skipping');
    return;
  }

  seedLogger.info('Seeding dev data');

  const { companyId, userId } = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SEED_ADVISORY_LOCK_KEY}::bigint)`);
    const [existingUser] = await tx
      .select()
      .from(users)
      .where(eq(users.email, DEMO_USER_EMAIL))
      .limit(1);
    const companyId = await ensureDemoCompany(tx, existingUser?.companyId ?? null);
    const userId = await ensureDemoUser(tx, companyId);
    await ensureMockDeploySetup(tx, companyId, userId);
    return { companyId, userId };
  });

  await seedDevTelemetry(companyId, userId);
  seedLogger.info('Dev seed complete', { companyId, userId });
}
