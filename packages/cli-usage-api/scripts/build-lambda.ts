// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bundles the Lambda entry point and its dependencies into `dist/index.mjs` for the
 * `nodejs24.x` runtime, with the handler exported as `index.handler`.
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const PACKAGE_DIR = join(import.meta.dir, '..');
const OUT_DIR = join(PACKAGE_DIR, 'dist');

await rm(OUT_DIR, { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: [join(PACKAGE_DIR, 'src/lambda.ts')],
  outdir: OUT_DIR,
  naming: 'index.mjs',
  target: 'node',
  format: 'esm',
  sourcemap: 'linked',
});

if (!result.success) {
  for (const message of result.logs) console.error(message);
  process.exit(1);
}
for (const output of result.outputs) console.info(`${output.path} (${output.size} bytes)`);
