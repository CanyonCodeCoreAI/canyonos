// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Builds every CanyonOS image from this checkout, syncs the workspace venv, and opens a shell in
 * which `canyonos` is the CLI from this checkout using those images. `exit` leaves it. When the
 * local kind cluster (scripts/kind/up.sh) exists, CanyonOS on it is brought up to date too.
 * `--images-only` stops after the images, for scripts such as scripts/kind/e2e.sh.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { $ } from 'bun';

const ROOT = join(import.meta.dir, '..');
const VENV = join(ROOT, '.venv');
const CLI_ENV = join(ROOT, 'packages/cli/.env');

$.cwd(ROOT);

await $`docker build -f packages/core/Dockerfile -t canyonos-core:dev packages/core`;
await $`docker build -f packages/api/Dockerfile -t canyonos-api:dev .`;
await $`docker build -f packages/web/Dockerfile --target canyonos --build-arg VITE_API_URL=/api -t canyonos-web:dev .`;

if (process.argv.includes('--images-only')) process.exit(0);

// The kind cluster runs these images too: push them there and upgrade it, so it never runs an
// older CanyonOS than the dev shell. Without kind or the cluster there is nothing to do, and a
// failed update still opens the shell.
const CLUSTER = Bun.env.CANYONOS_KIND_CLUSTER || 'canyonos';
const clusters = await $`kind get clusters`.nothrow().quiet().text();
if (clusters.split(/\r?\n/).includes(CLUSTER)) {
  console.log(`\nUpdating CanyonOS on the kind cluster ${CLUSTER} (scripts/kind/operator.sh)`);
  const { exitCode } = await $`${Bun.env.SHELL || 'bash'} scripts/kind/operator.sh`.nothrow();
  if (exitCode !== 0) {
    console.warn(`\nThe kind cluster ${CLUSTER} keeps its previous CanyonOS: see the error above.`);
  }
}

if (!existsSync(CLI_ENV)) await $`cp packages/cli/.env.example ${CLI_ENV}`;

await $`uv sync`;

console.log('\nCanyonOS dev shell: `canyonos` runs from this checkout. Type `exit` to leave.\n');

const shell = Bun.spawn([Bun.env.SHELL || '/bin/sh'], {
  cwd: ROOT,
  env: {
    ...Bun.env,
    VIRTUAL_ENV: VENV,
    PATH: `${join(VENV, 'bin')}:${Bun.env.PATH}`,
  },
  stdio: ['inherit', 'inherit', 'inherit'],
});
process.exit(await shell.exited);
