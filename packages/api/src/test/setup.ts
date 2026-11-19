// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import postgres from 'postgres';

import { hashApiKey, TEST_API_KEY, TEST_CONTROL_KEY } from './api-key-test.utils';

const isSafeIdentifier = (value: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);

async function resetPostgresTestDatabase(): Promise<void> {
  if (Bun.env.NODE_ENV !== 'test') return;
  const databaseUrl = Bun.env.DATABASE_URL;
  if (!databaseUrl?.startsWith('postgres')) return;

  const url = new URL(databaseUrl);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (!isSafeIdentifier(databaseName)) {
    throw new Error(`Unsafe test database name: ${databaseName}`);
  }

  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';

  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => undefined });
  const database = await admin`SELECT 1 FROM pg_database WHERE datname = ${databaseName}`;
  if (database.length === 0) {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  }
  await admin.end();

  const testDb = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  await testDb`DROP SCHEMA IF EXISTS drizzle CASCADE`;
  await testDb`DROP SCHEMA IF EXISTS public CASCADE`;
  await testDb`CREATE SCHEMA public`;
  await testDb`GRANT ALL ON SCHEMA public TO public`;
  await testDb.end();
}

/**
 * What the suite runs against unless the shell or `.env.test` says otherwise, set before `env.ts`
 * reads them: the `canyonos_test` database beside the one `bun run docker:up` starts, a Redis on
 * loopback, and the hashes of the keys the tests send. A value the run sets, empty included, is
 * kept.
 */
function setTestDefaults(): void {
  const env = process.env;
  env.DATABASE_URL ??= 'postgres://canyonos:canyonos@localhost:5432/canyonos_test';
  env.PORT ??= '3001';
  env.API_URL ??= `http://localhost:${env.PORT}`;
  env.LOG_LEVEL ??= 'warn';
  env.CANYONOS_REDIS_HOST ??= '127.0.0.1';
  env.CANYONOS_REDIS_PORT ??= '6379';
  env.CANYONOS_API_KEY_HASH ??= hashApiKey(TEST_API_KEY);
  env.CANYONOS_CONTROL_KEY_HASH ??= hashApiKey(TEST_CONTROL_KEY);
}

setTestDefaults();
await resetPostgresTestDatabase();
export {};
