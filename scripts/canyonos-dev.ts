/**
 * Builds every CanyonOS image from this checkout, syncs the workspace venv, and opens a shell in
 * which `canyonos` is the CLI from this checkout using those images. `exit` leaves it.
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
await $`docker build -f packages/web/Dockerfile --target canyonos --build-arg VITE_API_URL=/api --build-arg VITE_CANYONOS_LOCAL_MODE=true -t canyonos-web:dev .`;

if (!existsSync(CLI_ENV)) await $`cp packages/cli/.env.example ${CLI_ENV}`;

await $`uv sync`;

console.log('\nCanyonOS dev shell: `canyonos` runs from this checkout. Type `exit` to leave.\n');

const shell = Bun.spawn([Bun.env.SHELL ?? '/bin/sh'], {
  cwd: ROOT,
  env: {
    ...Bun.env,
    VIRTUAL_ENV: VENV,
    PATH: `${join(VENV, 'bin')}:${Bun.env.PATH}`,
  },
  stdio: ['inherit', 'inherit', 'inherit'],
});
process.exit(await shell.exited);
