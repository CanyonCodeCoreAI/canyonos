import { eq } from 'drizzle-orm';

import { db } from '@api/db/client';
import { companies, projects, users } from '@api/db/schema';
import { internalError } from '@core/errors';
import { LOG_DOMAINS, logger } from '@core/logger';

import { UUID_RE } from '../auth/project-access';
import { UserStatusEnum } from '../auth/types';
import { CONTROLLER_IDENTITY_KEY, with_redis } from './canyonos.redis';

const ADMIN_NAME = 'admin';
// `.invalid` is reserved by RFC 2606, so this placeholder address can never route.
export const ADMIN_EMAIL = 'admin@canyonos.invalid';
const DEFAULT_PROJECT_NAME = 'project_1';

const canyonos_logger = logger.child({ domain: LOG_DOMAINS.DB });

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface AdminOwner {
  readonly user_id: string;
  readonly company_id: string;
}

async function ensure_admin_owner(tx: Tx): Promise<AdminOwner> {
  const [existing] = await tx
    .select({ user_id: users.id, company_id: users.companyId })
    .from(users)
    .where(eq(users.email, ADMIN_EMAIL))
    .limit(1);
  if (existing?.company_id) return { user_id: existing.user_id, company_id: existing.company_id };

  const [company] = await tx.insert(companies).values({ name: ADMIN_NAME }).returning();
  if (!company) throw internalError('canyonos.bootstrap_failed', 'Admin company was not created');

  const [user] = await tx
    .insert(users)
    .values({
      email: ADMIN_EMAIL,
      name: ADMIN_NAME,
      companyId: company.id,
      status: UserStatusEnum.ACTIVE,
    })
    .returning({ id: users.id });
  if (!user) throw internalError('canyonos.bootstrap_failed', 'Admin user was not created');
  return { user_id: user.id, company_id: company.id };
}

export async function ensure_canyonos_admin(): Promise<AdminOwner> {
  return db.transaction((tx) => ensure_admin_owner(tx));
}

/** An existing project short-circuits: its name, company, creator, and timestamps are never rewritten. */
export async function ensure_canyonos_project(
  project_id: string | null,
  project_name?: string | null
): Promise<boolean> {
  if (project_id === null || !UUID_RE.test(project_id)) {
    canyonos_logger.warn('CanyonOS identity is unusable, bootstrapping no project', { project_id });
    return false;
  }

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, project_id))
      .limit(1);
    if (existing) return;

    const { user_id, company_id } = await ensure_admin_owner(tx);
    await tx
      .insert(projects)
      .values({
        id: project_id,
        company_id,
        created_by: user_id,
        name: project_name || DEFAULT_PROJECT_NAME,
      })
      .onConflictDoNothing();
  });
  return true;
}

export async function bootstrap_canyonos(): Promise<void> {
  await ensure_canyonos_admin();

  // An unreachable controller is the same outcome as a missing id.
  const identity = await with_redis(async (redis) => ({
    project_id: await redis.hget(CONTROLLER_IDENTITY_KEY, 'project_id'),
    project_name: await redis.hget(CONTROLLER_IDENTITY_KEY, 'project_name'),
  })).catch(() => ({ project_id: null, project_name: null }));
  await ensure_canyonos_project(identity.project_id, identity.project_name);
}
