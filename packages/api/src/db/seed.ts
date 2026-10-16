// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { config } from '@core/env';
import { LOG_DOMAINS, logger } from '@core/logger';

import { hashPassword } from '../modules/auth/lib/password';
import { db } from './client';
import { users } from './schema';
import { seedDevTelemetry } from './seed-telemetry';

const seedLogger = logger.child({ domain: LOG_DOMAINS.DB });

const DEMO_USER_EMAIL = 'e2e@canyonos.test';
const DEMO_USER_PASSWORD = 'e2e-password-1';

/** Seed opt-in development data while remaining a no-op in production. */
export async function seedDevData(): Promise<void> {
  if (config.isProduction || !config.seed.devData) {
    seedLogger.info('Dev seed disabled — skipping');
    return;
  }

  seedLogger.info('Seeding dev data');

  const password_hash = await hashPassword(DEMO_USER_PASSWORD);
  await db
    .insert(users)
    .values({ email: DEMO_USER_EMAIL, password_hash })
    .onConflictDoUpdate({ target: users.email, set: { password_hash } });

  const projectId = await seedDevTelemetry();
  seedLogger.info('Dev seed complete', { email: DEMO_USER_EMAIL, projectId });
}
