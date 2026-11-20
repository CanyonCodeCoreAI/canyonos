// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { database_state, ping_database } from '@api/db/database';
import * as docker from '@core/docker';
import { config } from '@core/env';

import type { DatabaseCheck, DockerCheck, Health, Readiness } from './health.types';

const DATABASE_PING_TIMEOUT_MS = 1_000;

export function health(): Health {
  return {
    status: 'ok',
    version: process.env.GIT_COMMIT_SHA || process.env.RAILWAY_GIT_COMMIT_SHA || 'unknown',
    timestamp: new Date().toISOString(),
  };
}

async function check_database(): Promise<DatabaseCheck> {
  const state = database_state();
  if (state !== 'ready') return state;
  return (await ping_database(DATABASE_PING_TIMEOUT_MS)) ? 'ok' : 'unreachable';
}

async function check_docker(): Promise<DockerCheck> {
  if (config.docker.socket === null) return 'disabled';
  return docker.ping().then(
    () => 'ok' as const,
    () => 'unreachable' as const
  );
}

/** Ready once the database is migrated and answers. Docker is reported, never waited on: an
 * API without it still serves the dashboard, and its /v1/workflow-groups routes answer 503 `docker.unavailable`
 * themselves. */
export async function readiness(): Promise<Readiness> {
  const [database, docker_check] = await Promise.all([check_database(), check_docker()]);
  return {
    status: database === 'ok' ? 'ready' : 'not_ready',
    checks: { database, docker: docker_check },
  };
}
