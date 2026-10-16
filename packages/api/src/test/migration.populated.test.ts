// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

import { db, runMigrations, sql } from '@api/db/client';

const MIGRATIONS = new URL('../db/migrations', import.meta.url).pathname;
const PASSWORD_AUTH_TAG = '0005_password_auth';

interface Journal {
  entries: { tag: string }[];
}

interface Seeded {
  project_id: string;
  file_id: string;
  deploy_setup_id: string;
  deployment_id: string;
}

let before_password_auth: string;
let seeded: Seeded;

/** Migrates with a journal copy that stops right before 0005, the shape a running install has. */
async function migrate_before_password_auth(): Promise<void> {
  before_password_auth = await mkdtemp(join(tmpdir(), 'canyonos-migrations-'));
  await cp(MIGRATIONS, before_password_auth, { recursive: true });
  const journal_path = join(before_password_auth, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journal_path, 'utf8')) as Journal;
  const cut = journal.entries.findIndex(({ tag }) => tag === PASSWORD_AUTH_TAG);
  expect(cut).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, cut);
  await writeFile(journal_path, JSON.stringify(journal));
  await migrate(db, { migrationsFolder: before_password_auth });
}

async function seed_otp_install(): Promise<Seeded> {
  const [company] = await sql<{ id: string }[]>`
    INSERT INTO companies (name) VALUES ('admin') RETURNING id
  `;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, name, company_id, status)
    VALUES ('admin@canyonos.invalid', 'admin', ${company!.id}, 'ACTIVE') RETURNING id
  `;
  await sql`
    INSERT INTO auth_challenges (user_id, destination, purpose, code_hash, expires_at)
    VALUES (${user!.id}, 'admin@canyonos.invalid', 'login', 'hash', now())
  `;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (company_id, created_by, name, redis_port)
    VALUES (${company!.id}, ${user!.id}, 'controller', 6380) RETURNING id
  `;
  await sql`INSERT INTO file_blobs (content_hash, byte_size) VALUES ('blob', 4)`;
  const [file] = await sql<{ id: string }[]>`
    INSERT INTO files (company_id, project_id, created_by, path, name, content_hash, language,
      byte_size, component_kind)
    VALUES (${company!.id}, ${project!.id}, ${user!.id}, 'agent.py', 'agent.py', 'blob', 'python',
      4, 'agent')
    RETURNING id
  `;
  const [setup] = await sql<{ id: string }[]>`
    INSERT INTO deploy_setups (name, company_id, created_by, region, ami_id, instance_type,
      subnet_id, security_group_ids, ssh_user, ssh_private_key_path)
    VALUES ('setup', ${company!.id}, ${user!.id}, 'us-east-1', 'ami', 't3.small', 'subnet', 'sg',
      'ubuntu', '/key')
    RETURNING id
  `;
  const [deployment] = await sql<{ id: string }[]>`
    INSERT INTO deployments (project_id, company_id, created_by, deploy_setup_id, status)
    VALUES (${project!.id}, ${company!.id}, ${user!.id}, ${setup!.id}, 'success') RETURNING id
  `;
  return {
    project_id: project!.id,
    file_id: file!.id,
    deploy_setup_id: setup!.id,
    deployment_id: deployment!.id,
  };
}

beforeAll(async () => {
  await migrate_before_password_auth();
  seeded = await seed_otp_install();
  await runMigrations();
});

afterAll(async () => {
  await rm(before_password_auth, { recursive: true, force: true });
});

describe('migration 0005 on a populated database', () => {
  test('companies and auth_challenges are gone', async () => {
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('companies', 'auth_challenges')
    `;
    expect(tables).toHaveLength(0);
  });

  test('users is emptied and requires a password hash', async () => {
    const [count] = await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM users`;
    expect(count!.total).toBe(0);

    const [column] = await sql<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'password_hash'
    `;
    expect(column?.is_nullable).toBe('NO');
  });

  test('the project survives with its name and port and no creator', async () => {
    const [project] = await sql`
      SELECT id, name, created_by, redis_port FROM projects WHERE id = ${seeded.project_id}
    `;
    expect(project).toEqual({
      id: seeded.project_id,
      name: 'controller',
      created_by: null,
      redis_port: 6380,
    });

    const company_column = await sql`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'company_id'
    `;
    expect(company_column).toHaveLength(0);
  });

  test('the file, deploy setup and deployment survive with no creator', async () => {
    const rows = await sql<{ kind: string; created_by: string | null }[]>`
      SELECT 'file' AS kind, created_by FROM files WHERE id = ${seeded.file_id}
      UNION ALL
      SELECT 'deploy_setup', created_by FROM deploy_setups WHERE id = ${seeded.deploy_setup_id}
      UNION ALL
      SELECT 'deployment', created_by FROM deployments WHERE id = ${seeded.deployment_id}
    `;
    expect(rows.map((row) => ({ ...row }))).toEqual([
      { kind: 'file', created_by: null },
      { kind: 'deploy_setup', created_by: null },
      { kind: 'deployment', created_by: null },
    ]);
  });
});
