// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test';

import { sql as postgres } from '@api/db/client';

import { setupE2ETests } from './e2e.setup';

setupE2ETests();

const LEGACY_TABLES = ['agent_information', 'runtime_information', 'session'];

// The deploy queue the retired Flask server ran: 0013 drops its tables, the notify functions a
// custom migration gave them and their status type.
const DEPLOY_QUEUE_TABLES = [
  'deploy_setups',
  'deployment_events',
  'deployment_files',
  'deployments',
];
const DEPLOY_QUEUE_FUNCTIONS = ['notify_deploy_event', 'notify_deploy_job'];

describe('migration baseline', () => {
  test('the legacy runtime tables and their enum are gone', async () => {
    const tables = await postgres<{ name: string }[]>`
      SELECT c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN ${postgres(LEGACY_TABLES)}
    `;
    expect(tables.map((row) => row.name)).toEqual([]);

    const types = await postgres<{ typname: string }[]>`
      SELECT typname FROM pg_type WHERE typname = 'session_status'
    `;
    expect(types.map((row) => row.typname)).toEqual([]);
  });

  test('the deploy queue is gone: its tables, functions, triggers and status type', async () => {
    const tables = await postgres<{ name: string }[]>`
      SELECT c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN ${postgres(DEPLOY_QUEUE_TABLES)}
    `;
    expect(tables.map((row) => row.name)).toEqual([]);

    const functions = await postgres<{ proname: string }[]>`
      SELECT p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ${postgres(DEPLOY_QUEUE_FUNCTIONS)}
    `;
    expect(functions.map((row) => row.proname)).toEqual([]);

    const types = await postgres<{ typname: string }[]>`
      SELECT typname FROM pg_type WHERE typname = 'deployment_status'
    `;
    expect(types.map((row) => row.typname)).toEqual([]);
  });

  test('the schema carries no trigger of its own', async () => {
    const triggers = await postgres<{ table_name: string; tgname: string }[]>`
      SELECT c.relname AS table_name, t.tgname
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal
    `;
    expect(triggers.map((row) => [row.table_name, row.tgname])).toEqual([]);
  });

  test('companies, auth_challenges, users and the workflow columns pointing at them are gone', async () => {
    const tables = await postgres<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('companies', 'auth_challenges', 'users')
    `;
    expect(tables).toHaveLength(0);

    const columns = await postgres<
      { table_name: string; column_name: string; is_nullable: string }[]
    >`
      SELECT table_name, column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (table_name, column_name) IN (
          ('workflows', 'company_id'),
          ('workflows', 'created_by')
        )
      ORDER BY table_name, column_name
    `;
    expect(
      columns.map(({ table_name, column_name, is_nullable }) => ({
        table_name,
        column_name,
        is_nullable,
      }))
    ).toEqual([]);
  });
});
