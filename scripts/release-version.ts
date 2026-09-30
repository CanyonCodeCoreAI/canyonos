import { join } from 'node:path';

export type Manifest = { path: string; pattern: RegExp };

// Every file that states the shared version. `uv lock` derives the lockfile entries
// from the pyproject files, so `set` never writes those; `check` still reads them.
export const manifests: Manifest[] = [
  { path: 'packages/cli/pyproject.toml', pattern: /^(version = ")([^"]+)(")$/m },
  { path: 'packages/core/pyproject.toml', pattern: /^(version = ")([^"]+)(")$/m },
  { path: 'packages/core/canyonos_core/__init__.py', pattern: /^(__version__ = ")([^"]+)(")$/m },
  { path: 'packages/api/package.json', pattern: /^(\s*"version": ")([^"]+)(",?)$/m },
  { path: 'packages/web/package.json', pattern: /^(\s*"version": ")([^"]+)(",?)$/m },
];

export const lockfileEntries: Manifest[] = [
  { path: 'uv.lock (canyonos)', pattern: /^(name = "canyonos"\nversion = ")([^"]+)(")$/m },
  {
    path: 'uv.lock (canyonos-core)',
    pattern: /^(name = "canyonos-core"\nversion = ")([^"]+)(")$/m,
  },
];

const releaseVersionPattern = /^\d+\.\d+\.\d+$/;

export function isReleaseVersion(version: string): boolean {
  return releaseVersionPattern.test(version);
}

export function readVersion(manifest: Manifest, content: string): string {
  const version = content.match(manifest.pattern)?.[2];
  if (!version) throw new Error(`${manifest.path} has no version line.`);
  return version;
}

export function writeVersion(manifest: Manifest, content: string, version: string): string {
  readVersion(manifest, content);
  return content.replace(manifest.pattern, `$1${version}$3`);
}

export function findProblems(
  found: Array<{ path: string; version: string }>,
  expected?: string
): string[] {
  const malformed = found
    .filter((entry) => !isReleaseVersion(entry.version))
    .map((entry) => `${entry.path} is ${entry.version}, not a release version like 0.1.732.`);
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
    throw new Error(`${version} is not a release version like 0.1.732.`);
  }
  for (const manifest of manifests) {
    const file = Bun.file(join(root, manifest.path));
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
