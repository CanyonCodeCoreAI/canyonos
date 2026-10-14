// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { join } from 'node:path';

import { isReleaseVersion } from './release-version';

// The latest stable CLI release and the two before it.
export const supportedCount = 3;

export type SupportedVersions = { latest: string; supported: string[] };

function newestFirst(a: string, b: string): number {
  const [left, right] = [a, b].map((version) => version.split('.').map(Number));
  for (let i = 0; i < 3; i++) {
    if (left![i] !== right![i]) return right![i]! - left![i]!;
  }
  return 0;
}

export function supportedWindow(versions: string[]): SupportedVersions {
  for (const version of versions) {
    if (!isReleaseVersion(version)) {
      throw new Error(`${version} is not a release version like 0.1.732.`);
    }
  }
  const supported = [...new Set(versions)].sort(newestFirst).slice(0, supportedCount);
  return { latest: supported[0]!, supported };
}

export function addRelease(current: SupportedVersions, version: string): SupportedVersions {
  return supportedWindow([version, ...current.supported]);
}

export function renderSupportedVersions(versions: SupportedVersions): string {
  return `${JSON.stringify(versions, null, 2)}\n`;
}

// Every published release is passed in, not only the new one: the file on main lags
// while the previous release's pull request waits for a merge, and a window built
// from it alone would drop that release.
if (import.meta.main) {
  const versions = process.argv.slice(2);
  if (versions.length === 0) {
    throw new Error('Usage: bun run scripts/supported-versions.ts <version>...');
  }
  const file = Bun.file(join(import.meta.dir, '..', 'packages', 'cli', 'supported-versions.json'));
  const current = (await file.json()) as SupportedVersions;
  await Bun.write(file, renderSupportedVersions(supportedWindow([...versions, ...current.supported])));
}
