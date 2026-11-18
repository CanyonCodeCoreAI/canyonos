// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

import { forgeApi } from '@api/app';
import { db, runMigrations, sql } from '@api/db/client';

import { bearer, TEST_API_KEY } from './project-test.utils';

const MIGRATIONS = new URL('../db/migrations', import.meta.url).pathname;
const PASSWORD_AUTH_TAG = '0005_password_auth';
const DROP_USERS_TAG = '0009_drop_users';

interface Journal {
  entries: { tag: string }[];
}

interface Seeded {
  project_id: string;
  file_id: string;
  deploy_setup_id: string;
  deployment_id: string;
}

interface PasswordSeeded {
  project_id: string;
  prompt_id: string;
}

const copies: string[] = [];
let seeded: Seeded;
let password_seeded: PasswordSeeded;
let after_password_auth: Record<string, unknown>[];

/** Migrates with a journal copy that stops right before `tag`, the shape a running install has. */
async function migrate_before(tag: string): Promise<void> {
  const copy = await mkdtemp(join(tmpdir(), 'canyonos-migrations-'));
  copies.push(copy);
  await cp(MIGRATIONS, copy, { recursive: true });
  const journal_path = join(copy, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journal_path, 'utf8')) as Journal;
  const cut = journal.entries.findIndex((entry) => entry.tag === tag);
  expect(cut).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, cut);
  await writeFile(journal_path, JSON.stringify(journal));
  await migrate(db, { migrationsFolder: copy });
}

/** A password install: one account, which created the project, its file, prompt and deploy. */
async function seed_password_install(): Promise<PasswordSeeded> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, password_hash) VALUES ('admin@canyonos.invalid', 'hash') RETURNING id
  `;
  await sql`UPDATE projects SET created_by = ${user!.id} WHERE id = ${seeded.project_id}`;
  await sql`UPDATE files SET created_by = ${user!.id} WHERE id = ${seeded.file_id}`;
  await sql`UPDATE deploy_setups SET created_by = ${user!.id} WHERE id = ${seeded.deploy_setup_id}`;
  await sql`UPDATE deployments SET created_by = ${user!.id} WHERE id = ${seeded.deployment_id}`;
  const [prompt] = await sql<{ id: string }[]>`
    INSERT INTO system_prompts (project_id, name, version, content, live)
    VALUES (${seeded.project_id}, 'Agent.run', 'Agent-run-00000001-v1', 'Be brief.', true)
    RETURNING id
  `;
  return { project_id: seeded.project_id, prompt_id: prompt!.id };
}

const creators = () => sql<{ kind: string; created_by: string | null }[]>`
  SELECT 'project' AS kind, created_by FROM projects WHERE id = ${seeded.project_id}
  UNION ALL
  SELECT 'file', created_by FROM files WHERE id = ${seeded.file_id}
  UNION ALL
  SELECT 'deploy_setup', created_by FROM deploy_setups WHERE id = ${seeded.deploy_setup_id}
  UNION ALL
  SELECT 'deployment', created_by FROM deployments WHERE id = ${seeded.deployment_id}
`;

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
  await migrate_before(PASSWORD_AUTH_TAG);
  seeded = await seed_otp_install();
  await migrate_before(DROP_USERS_TAG);
  after_password_auth = (await creators()).map((row) => ({ ...row }));
  password_seeded = await seed_password_install();
  await runMigrations();
});

afterAll(async () => {
  for (const copy of copies) await rm(copy, { recursive: true, force: true });
});

describe('migration 0005 on a populated database', () => {
  test('companies and auth_challenges are gone', async () => {
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('companies', 'auth_challenges')
    `;
    expect(tables).toHaveLength(0);
  });

  test('the project survives with its name and port', async () => {
    const [project] = await sql`
      SELECT id, name, redis_port FROM projects WHERE id = ${seeded.project_id}
    `;
    expect(project).toEqual({ id: seeded.project_id, name: 'controller', redis_port: 6380 });

    const company_column = await sql`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'company_id'
    `;
    expect(company_column).toHaveLength(0);
  });

  test('the project, file, deploy setup and deployment lose their creator', () => {
    expect(after_password_auth).toEqual([
      { kind: 'project', created_by: null },
      { kind: 'file', created_by: null },
      { kind: 'deploy_setup', created_by: null },
      { kind: 'deployment', created_by: null },
    ]);
  });
});

describe('migration 0009 on a password install', () => {
  test('users, the foreign keys into it and every created_by column are gone', async () => {
    const tables = await sql`
      SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users'
    `;
    expect(tables).toHaveLength(0);

    const constraints = await sql`
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = 'public' AND constraint_name LIKE '%created_by_users_id_fk'
    `;
    expect(constraints).toHaveLength(0);

    const columns = await sql`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'created_by'
    `;
    expect(columns).toHaveLength(0);
  });

  test('the project, its file, prompt, deploy setup and deployment survive', async () => {
    const rows = await sql<{ kind: string }[]>`
      SELECT 'project' AS kind FROM projects WHERE id = ${seeded.project_id}
      UNION ALL
      SELECT 'file' FROM files WHERE id = ${seeded.file_id}
      UNION ALL
      SELECT 'prompt' FROM system_prompts WHERE id = ${password_seeded.prompt_id}
      UNION ALL
      SELECT 'deploy_setup' FROM deploy_setups WHERE id = ${seeded.deploy_setup_id}
      UNION ALL
      SELECT 'deployment' FROM deployments WHERE id = ${seeded.deployment_id}
    `;
    expect(rows.map(({ kind }) => kind)).toEqual([
      'project',
      'file',
      'prompt',
      'deploy_setup',
      'deployment',
    ]);

    const [prompt] =
      await sql`SELECT content, live FROM system_prompts WHERE id = ${password_seeded.prompt_id}`;
    expect(prompt).toEqual({ content: 'Be brief.', live: true });
  });

  test('the API key lists the project', async () => {
    const response = await forgeApi.handle(
      new Request('http://localhost/projects', { headers: bearer(TEST_API_KEY) })
    );

    expect(response.status).toBe(200);
    const listed = (await response.json()) as { id: string; name: string }[];
    expect(listed).toContainEqual(
      expect.objectContaining({ id: password_seeded.project_id, name: 'controller' })
    );
  });
});
