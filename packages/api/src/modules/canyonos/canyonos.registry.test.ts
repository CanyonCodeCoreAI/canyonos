// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { forget_registry, registered_projects } from './canyonos.registry';
import type { RegistryEntry } from './canyonos.registry';

const PROJECT_ID = '4eeed6f3-1c2b-4c1d-9d8e-0a1b2c3d4e5f';

const entry = (overrides: Partial<RegistryEntry['redis']> = {}): RegistryEntry => ({
  project_id: PROJECT_ID,
  name: 'acme',
  redis: {
    host: 'canyonos-redis.acme.svc',
    port: 6379,
    tls: false,
    username: '',
    password: 's3cret',
    ...overrides,
  },
});

describe('registered_projects', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    forget_registry();
    dir = mkdtempSync(join(tmpdir(), 'registry-'));
    path = join(dir, 'projects.json');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('without a file there are no listed projects', () => {
    expect(registered_projects(null).size).toBe(0);
    expect(registered_projects(path).size).toBe(0);
  });

  test('the operator lists each project with its Redis', () => {
    writeFileSync(path, JSON.stringify({ projects: [entry()] }));

    const listed = registered_projects(path).get(PROJECT_ID);

    expect(listed?.name).toBe('acme');
    expect(listed?.redis).toEqual({
      host: 'canyonos-redis.acme.svc',
      port: 6379,
      tls: false,
      username: '',
      password: 's3cret',
    });
  });

  test('a replaced file is read again', () => {
    writeFileSync(path, JSON.stringify({ projects: [] }));
    expect(registered_projects(path).size).toBe(0);

    writeFileSync(path, JSON.stringify({ projects: [entry()] }));
    utimesSync(path, new Date(), new Date(Date.now() + 5000));

    expect(registered_projects(path).size).toBe(1);
  });

  test('a broken file keeps the last good list', () => {
    writeFileSync(path, JSON.stringify({ projects: [entry()] }));
    expect(registered_projects(path).size).toBe(1);

    writeFileSync(path, '{"projects": [');
    utimesSync(path, new Date(), new Date(Date.now() + 5000));

    expect(registered_projects(path).size).toBe(1);
  });
});
