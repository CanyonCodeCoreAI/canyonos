/**
 * Runs the dashboard on the host for the hot-reload loop: local Postgres and Mailpit
 * through Compose, then the API and Vite in watch mode. A variable set in the shell wins over each
 * default below.
 */

import { join } from 'node:path';

import { $ } from 'bun';

const ROOT = join(import.meta.dir, '..');
const env = Bun.env;

$.cwd(ROOT);

await $`docker compose -f .docker/docker-compose.yml up -d --wait`;

const dev = Bun.spawn(['turbo', 'run', 'dev', '--filter=@canyonos/api', '--filter=web'], {
  cwd: ROOT,
  env: {
    ...env,
    APP_ENV: env.APP_ENV || 'development',
    AUTH_MODE: env.AUTH_MODE || 'fixed_code',
    // The API image defaults to host.docker.internal; on the host the workflow's Redis is local.
    CANYONOS_REDIS_HOST: env.CANYONOS_REDIS_HOST || '127.0.0.1',
    CANYONOS_REDIS_PORT: env.CANYONOS_REDIS_PORT || '6379',
    DEPLOY_WORKER: env.DEPLOY_WORKER || 'none',
    JWT_SECRET: env.JWT_SECRET || 'canyonos-local-development-only-secret',
    VITE_API_URL: env.VITE_API_URL || env.API_URL || `http://localhost:${env.PORT || '3000'}`,
    VITE_CANYONOS_LOCAL_MODE: env.VITE_CANYONOS_LOCAL_MODE || 'true',
  },
  stdio: ['inherit', 'inherit', 'inherit'],
});
process.exit(await dev.exited);
