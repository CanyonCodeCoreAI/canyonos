// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Builds every CanyonOS image from this checkout, syncs the workspace venv, and opens a shell in
 * which `canyonos` is the CLI from this checkout using those images. `exit` leaves it. When the
 * local kind cluster (scripts/kind/up.sh) exists, CanyonOS on it is brought up to date too.
 * `--images-only` stops after the images, for scripts such as scripts/kind/e2e.sh.
 */

import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { $ } from 'bun';

const ROOT = join(import.meta.dir, '..');
const VENV = join(ROOT, '.venv');
const WINDOWS = process.platform === 'win32';
// Where the venv keeps `canyonos`: uv makes Scripts on Windows, bin elsewhere.
const VENV_BIN = join(VENV, WINDOWS ? 'Scripts' : 'bin');
const SHELL = Bun.env.SHELL || (WINDOWS ? Bun.env.ComSpec || 'cmd.exe' : '/bin/sh');
const CLI_ENV = join(ROOT, 'packages/cli/.env');

$.cwd(ROOT);

const imagesOnly = process.argv.includes('--images-only');
// The CLI steps don't use the images, so they run while the images build.
const cliReady = imagesOnly
  ? Promise.resolve()
  : (async () => {
      if (!existsSync(CLI_ENV)) await $`cp packages/cli/.env.example ${CLI_ENV}`;
      await $`uv sync`;
      // The CLI installs editable, so it reads the bundled workflows out of the
      // checkout. They are generated, not committed, and only `canyonos#build`
      // builds them -- this shell never runs it.
      await $`bun run starters:bundle`;
    })();
const BAKE = {
  target: {
    core: { context: 'packages/core', dockerfile: 'Dockerfile', tags: ['canyonos-core:dev'] },
    api: { context: '.', dockerfile: 'packages/api/Dockerfile', tags: ['canyonos-api:dev'] },
    web: {
      context: '.',
      dockerfile: 'packages/web/Dockerfile',
      target: 'canyonos',
      args: { VITE_API_URL: '/api' },
      tags: ['canyonos-web:dev'],
    },
  },
};
await $`docker buildx bake --load -f - core api web < ${new Response(JSON.stringify(BAKE))}`;

if (imagesOnly) process.exit(0);

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

await cliReady;

console.log('\nCanyonOS dev shell: `canyonos` runs from this checkout. Type `exit` to leave.\n');

const shell = Bun.spawn([SHELL], {
  cwd: ROOT,
  env: {
    ...Bun.env,
    VIRTUAL_ENV: VENV,
    PATH: `${VENV_BIN}${delimiter}${Bun.env.PATH}`,
  },
  stdio: ['inherit', 'inherit', 'inherit'],
});
process.exit(await shell.exited);
