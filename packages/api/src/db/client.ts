// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import { config } from '@core/env';

// postgres.js connects on the first query; a database that does not answer within this many
// seconds fails the query, which the API then answers 503 `database.unavailable`.
const CONNECT_TIMEOUT_S = 5;

export const sql = postgres(config.database.url, { connect_timeout: CONNECT_TIMEOUT_S });

export const db = drizzle(sql);

/** The transaction `db.transaction` hands its callback. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function run_migrations(): Promise<void> {
  await migrate(db, { migrationsFolder: new URL('./migrations', import.meta.url).pathname });
}

// How long close_db lets running queries finish before it closes their connections.
const CLOSE_TIMEOUT_S = 2;

export async function close_db(): Promise<void> {
  await sql.end({ timeout: CLOSE_TIMEOUT_S });
}
