import { describe, expect, test } from 'bun:test';

import {
  findProblems,
  isReleaseVersion,
  lockfileEntries,
  manifests,
  readVersion,
  writeVersion,
} from './release-version';

const pyproject = '[project]\nname = "canyonos"\nversion = "0.1.731"\nrequires-python = ">=3.11"\n';
const initFile = '# CanyonOS - Distributed Agent Framework\n__version__ = "0.3.0"\n';
const packageJson =
  '{\n  "name": "web",\n  "private": true,\n  "version": "0.1.2",\n  "type": "module"\n}\n';
const lockfile =
  '[[package]]\nname = "canyonos"\nversion = "0.1.731"\nsource = { editable = "packages/cli" }\n\n[[package]]\nname = "canyonos-core"\nversion = "0.3.0"\nsource = { editable = "packages/core" }\n';

const manifest = (path: string) => {
  const found = [...manifests, ...lockfileEntries].find((entry) => entry.path === path);
  if (!found) throw new Error(`${path} is not a manifest`);
  return found;
};

describe('reading versions', () => {
  test('reads pyproject, __init__, package.json, and both lockfile entries', () => {
    expect(readVersion(manifest('packages/cli/pyproject.toml'), pyproject)).toBe('0.1.731');
    expect(readVersion(manifest('packages/core/canyonos_core/__init__.py'), initFile)).toBe(
      '0.3.0'
    );
    expect(readVersion(manifest('packages/web/package.json'), packageJson)).toBe('0.1.2');
    expect(lockfileEntries.map((entry) => readVersion(entry, lockfile))).toEqual([
      '0.1.731',
      '0.3.0',
    ]);
  });

  test('reports a manifest without a version line', () => {
    expect(() =>
      readVersion(manifest('packages/cli/pyproject.toml'), '[project]\nname = "x"\n')
    ).toThrow('packages/cli/pyproject.toml has no version line.');
  });
});

describe('writing versions', () => {
  test('rewrites only the version line of each manifest', () => {
    expect(writeVersion(manifest('packages/cli/pyproject.toml'), pyproject, '0.1.732')).toBe(
      '[project]\nname = "canyonos"\nversion = "0.1.732"\nrequires-python = ">=3.11"\n'
    );
    expect(
      writeVersion(manifest('packages/core/canyonos_core/__init__.py'), initFile, '0.1.732')
    ).toBe('# CanyonOS - Distributed Agent Framework\n__version__ = "0.1.732"\n');
    expect(writeVersion(manifest('packages/web/package.json'), packageJson, '0.1.732')).toBe(
      '{\n  "name": "web",\n  "private": true,\n  "version": "0.1.732",\n  "type": "module"\n}\n'
    );
  });
});

describe('checking versions', () => {
  const found = [
    { path: 'packages/cli/pyproject.toml', version: '0.1.732' },
    { path: 'packages/core/pyproject.toml', version: '0.1.732' },
    { path: 'uv.lock (canyonos-core)', version: '0.1.732' },
  ];

  test('passes when every manifest agrees', () => {
    expect(findProblems(found)).toEqual([]);
    expect(findProblems(found, '0.1.732')).toEqual([]);
  });

  test('names every manifest that disagrees', () => {
    expect(
      findProblems([...found, { path: 'packages/web/package.json', version: '0.1.2' }])
    ).toEqual(['packages/web/package.json is 0.1.2, but packages/cli/pyproject.toml is 0.1.732.']);
  });

  test('names the expected version when given one', () => {
    expect(findProblems(found, '0.1.733')).toEqual([
      'packages/cli/pyproject.toml is 0.1.732, expected 0.1.733.',
      'packages/core/pyproject.toml is 0.1.732, expected 0.1.733.',
      'uv.lock (canyonos-core) is 0.1.732, expected 0.1.733.',
    ]);
  });

  test('rejects a shared version that is not a release version', () => {
    const prerelease = found.map((entry) => ({ ...entry, version: '0.1.732-rc.1' }));
    expect(findProblems(prerelease)).toEqual([
      'packages/cli/pyproject.toml is 0.1.732-rc.1, not a release version like 0.1.732.',
      'packages/core/pyproject.toml is 0.1.732-rc.1, not a release version like 0.1.732.',
      'uv.lock (canyonos-core) is 0.1.732-rc.1, not a release version like 0.1.732.',
    ]);
  });

  test('refuses versions that are not MAJOR.MINOR.PATCH', () => {
    expect(isReleaseVersion('0.1.732')).toBe(true);
    expect(isReleaseVersion('v0.1.732')).toBe(false);
    expect(isReleaseVersion('0.1')).toBe(false);
    expect(isReleaseVersion('0.1.732-rc.1')).toBe(false);
  });
});
