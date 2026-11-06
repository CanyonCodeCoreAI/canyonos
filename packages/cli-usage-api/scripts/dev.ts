// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Runs the CLI usage API on the host for the hot-reload loop: starts a moto server through this
 * package's own Compose project, creates the bucket and the usage events stream when they are
 * missing, then serves the API on the loopback interface in watch mode.
 */

import { join } from 'node:path';

import { $ } from 'bun';

import { createAwsClients } from '../src/aws';
import { loadConfig, LOCAL_DEFAULTS } from '../src/config';
import { createBucketAndStream, waitForMoto } from '../src/usage.store';

const PACKAGE_DIR = join(import.meta.dir, '..');
const env = {
  ...process.env,
  APP_ENV: 'development',
  CLI_USAGE_AWS_ENDPOINT: LOCAL_DEFAULTS.awsEndpoint,
};
const config = loadConfig(env);

await $`docker compose -p canyonos-cli-usage -f ${join(PACKAGE_DIR, 'docker-compose.yml')} up -d`;

const clients = createAwsClients(config);
await waitForMoto(clients);
await createBucketAndStream(clients, config);
clients.firehose.destroy();
clients.s3.destroy();

const url = `http://127.0.0.1:${config.port}`;
console.info(`
moto server:   ${config.aws.kind === 'local' ? config.aws.endpoint : 'aws'} (bucket ${config.feedbackBucketName}, stream ${config.streamName})
CLI usage API: ${url}/usage/events and ${url}/feedback
Point the dev CLI at it with: export CANYONOS_USAGE_URL=${url}
Stop with Ctrl-C; \`bun run cli:usage:reset\` stops the moto server and deletes its data.
`);

const server = Bun.spawn(['bun', 'run', 'dev:server'], {
  cwd: PACKAGE_DIR,
  env,
  stdio: ['inherit', 'inherit', 'inherit'],
});
process.exit(await server.exited);
