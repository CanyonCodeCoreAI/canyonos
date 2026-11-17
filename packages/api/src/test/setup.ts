// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import postgres from 'postgres';

const VECTORS_PUBLIC_KEY = new URL('../../../../tests/auth-vectors/vectors.pub', import.meta.url)
  .pathname;

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
 * Trusts a key pair made for this run, and the shared vectors' key, before `env.ts` reads
 * `AUTH_TRUSTED_KEYS_DIR`. The private half travels in `E2E_SIGNING_KEY` for `signTestToken`.
 */
async function trustTestKeys(): Promise<void> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  const trusted = join(await mkdtemp(join(tmpdir(), 'canyonos-api-e2e-')), 'trusted');
  await mkdir(trusted);
  await writeFile(join(trusted, 'e2e.pub'), await exportSPKI(publicKey));
  await copyFile(VECTORS_PUBLIC_KEY, join(trusted, 'vectors.pub'));
  process.env.AUTH_TRUSTED_KEYS_DIR = trusted;
  process.env.E2E_SIGNING_KEY = await exportPKCS8(privateKey);
}

await resetPostgresTestDatabase();
await trustTestKeys();
export {};
