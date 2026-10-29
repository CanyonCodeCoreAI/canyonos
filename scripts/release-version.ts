// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { join } from 'node:path';

// `semver` marks a file that only takes SemVer, where 1.0.0rc1 is spelled 1.0.0-rc1.
export type Manifest = { path: string; pattern: RegExp; semver?: boolean };

// Every file that states the shared version. `uv lock` derives the lockfile entries
// from the pyproject files, so `set` never writes those; `check` still reads them.
export const manifests: Manifest[] = [
  { path: 'packages/cli/pyproject.toml', pattern: /^(version = ")([^"]+)(")$/m },
  { path: 'packages/core/pyproject.toml', pattern: /^(version = ")([^"]+)(")$/m },
  { path: 'packages/core/canyonos_core/__init__.py', pattern: /^(__version__ = ")([^"]+)(")$/m },
  { path: 'packages/api/package.json', pattern: /^(\s*"version": ")([^"]+)(",?)$/m },
  { path: 'packages/web/package.json', pattern: /^(\s*"version": ")([^"]+)(",?)$/m },
  // The operator image defaults to the chart's appVersion, so both follow the release.
  {
    path: 'packages/operator/charts/canyonos-operator/Chart.yaml (version)',
    pattern: /^(version: )([^\s"]+)()$/m,
    semver: true,
  },
  {
    path: 'packages/operator/charts/canyonos-operator/Chart.yaml (appVersion)',
    pattern: /^(appVersion: ")([^"]+)(")$/m,
  },
];

export const lockfileEntries: Manifest[] = [
  { path: 'uv.lock (canyonos)', pattern: /^(name = "canyonos"\nversion = ")([^"]+)(")$/m },
  {
    path: 'uv.lock (canyonos-core)',
    pattern: /^(name = "canyonos-core"\nversion = ")([^"]+)(")$/m,
  },
];

// A final release such as 0.1.732, or a release candidate such as 1.0.0rc1, spelled the
// way PEP 440 normalizes it so PyPI, uv.lock and the image tags all agree.
const releaseVersionPattern = /^\d+\.\d+\.\d+(?:rc\d+)?$/;

export function isReleaseVersion(version: string): boolean {
  return releaseVersionPattern.test(version);
}

export function readVersion(manifest: Manifest, content: string): string {
  const version = content.match(manifest.pattern)?.[2];
  if (!version) throw new Error(`${manifest.path} has no version line.`);
  return manifest.semver ? version.replace(/-(rc\d+)$/, '$1') : version;
}

export function writeVersion(manifest: Manifest, content: string, version: string): string {
  readVersion(manifest, content);
  const spelled = manifest.semver ? version.replace(/(rc\d+)$/, '-$1') : version;
  return content.replace(manifest.pattern, `$1${spelled}$3`);
}

export function findProblems(
  found: Array<{ path: string; version: string }>,
  expected?: string
): string[] {
  const malformed = found
    .filter((entry) => !isReleaseVersion(entry.version))
    .map(
      (entry) =>
        `${entry.path} is ${entry.version}, not a release version like 0.1.732 or 1.0.0rc1.`
    );
  const reference = expected ?? found[0]?.version;
  if (!reference) return malformed;
  const mismatched = found
    .filter((entry) => entry.version !== reference)
    .map((entry) =>
      expected
        ? `${entry.path} is ${entry.version}, expected ${expected}.`
        : `${entry.path} is ${entry.version}, but ${found[0]!.path} is ${reference}.`
    );
  return [...malformed, ...mismatched];
}

function fileOf(manifest: Manifest): string {
  return manifest.path.replace(/ \(.*\)$/, '');
}

async function readAll(root: string): Promise<Array<{ path: string; version: string }>> {
  return Promise.all(
    [...manifests, ...lockfileEntries].map(async (manifest) => ({
      path: manifest.path,
      version: readVersion(manifest, await Bun.file(join(root, fileOf(manifest))).text()),
    }))
  );
}

async function check(root: string, expected?: string): Promise<void> {
  const problems = findProblems(await readAll(root), expected);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exitCode = 1;
}

async function set(root: string, version: string): Promise<void> {
  if (!isReleaseVersion(version)) {
    throw new Error(`${version} is not a release version like 0.1.732 or 1.0.0rc1.`);
  }
  for (const manifest of manifests) {
    const file = Bun.file(join(root, fileOf(manifest)));
    await Bun.write(file, writeVersion(manifest, await file.text(), version));
  }
  const lock = Bun.spawnSync(['uv', 'lock'], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
  if (lock.exitCode !== 0) throw new Error('uv lock failed.');
  await check(root, version);
}

if (import.meta.main) {
  const root = join(import.meta.dir, '..');
  const [mode, version] = process.argv.slice(2);
  if (mode === 'check') {
    await check(root, version || undefined);
  } else if (mode === 'set' && version) {
    await set(root, version);
  } else {
    throw new Error('Usage: bun run scripts/release-version.ts check [version] | set <version>');
  }
}
