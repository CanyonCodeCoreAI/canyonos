// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeAll, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  bundleContents,
  bundleDir,
  bundleStarters,
  PYTHON_BUNDLE_SUFFIX,
  STARTERS,
} from './bundle-starters';

// The bundle is not committed; `canyonos#build` generates it. Every test below
// reads it, so build it here rather than relying on whatever is on disk.
beforeAll(() => {
  bundleStarters();
});

test('the bundle is built from examples/, not read from the repo', () => {
  rmSync(bundleDir, { recursive: true, force: true });
  expect(bundleContents()).toEqual({});

  bundleStarters();

  const built = bundleContents();
  expect(Object.keys(built).length).toBeGreaterThan(0);
  for (const starter of STARTERS) {
    expect(Object.keys(built).some((path) => path.startsWith(`${starter.name}/`))).toBe(true);
  }
});

test('a second build produces the same bundle', () => {
  const first = bundleContents();
  bundleStarters();
  // Whole-object compare, so the failure names every file that differed.
  expect(bundleContents()).toEqual(first);
});

test('every workflow ships, with its Python renamed so Nuitka leaves it alone', () => {
  const files = Object.keys(bundleContents());

  for (const starter of STARTERS) {
    expect(files.some((path) => path.startsWith(`${starter.name}/`))).toBe(true);
  }
  expect(files.some((path) => path.endsWith('.py'))).toBe(false);
  expect(files.some((path) => path.endsWith(`.py${PYTHON_BUNDLE_SUFFIX}`))).toBe(true);
});

test('a workflow needing a key ships a .env naming it, with a placeholder', () => {
  const files = bundleContents();

  for (const starter of STARTERS) {
    const env = files[`${starter.name}/.env`];
    if (!starter.env) {
      expect(env).toBeUndefined();
      continue;
    }
    expect(env).toBeDefined();
    // Not empty: an empty key stops the agents at startup and fails the deploy.
    expect(env).toContain('OPENAI_API_KEY=REPLACE_WITH_YOUR_API_KEY\n');
  }
});

test('no local state from running a workflow in place reaches the bundle', () => {
  const files = Object.keys(bundleContents());
  const leaked = files.filter((path) =>
    ['.venv/', '.canyon/', '.claude/', 'uv.lock', '.egg-info', '__pycache__', '.pyc'].some(
      (artifact) => path.includes(artifact)
    )
  );

  expect(leaked).toEqual([]);
});

test('the bundle lives inside the CLI package, so the wheel and binary carry it', () => {
  expect(bundleDir).toContain(join('packages', 'cli', 'canyonos'));
  expect(existsSync(bundleDir)).toBe(true);
});
