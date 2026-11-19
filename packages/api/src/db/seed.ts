// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { config } from '@core/env';
import { LOG_DOMAINS, logger } from '@core/logger';

import { seedDevTelemetry } from './seed-telemetry';

const seedLogger = logger.child({ domain: LOG_DOMAINS.DB });

/** Seed opt-in development data while remaining a no-op in production. */
export async function seedDevData(): Promise<void> {
  if (config.isProduction || !config.seed.devData) {
    seedLogger.info('Dev seed disabled — skipping');
    return;
  }

  seedLogger.info('Seeding dev data');
  const workflowId = await seedDevTelemetry();
  seedLogger.info('Dev seed complete', { workflowId });
}
