// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Makes the database `DATABASE_URL` names exist and be empty, on the server that URL names, for
 * an API to migrate and seed from nothing. `playwright.config.ts` runs it before the open API.
 */

import { SQL } from 'bun';

if (!Bun.env.DATABASE_URL) throw new Error('DATABASE_URL names no database');
const url = new URL(Bun.env.DATABASE_URL);
const name = decodeURIComponent(url.pathname.slice(1));
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Unsafe database name: ${name}`);

url.pathname = '/postgres';
const admin = new SQL(url.toString());
try {
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE "${name}"`);
} finally {
  await admin.close();
}
