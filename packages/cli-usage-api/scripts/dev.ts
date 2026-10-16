// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Runs the CLI usage API on the host for the hot-reload loop: starts DynamoDB Local through this
 * package's own Compose project, creates the usage events table when it is missing, then serves
 * the API on the loopback interface in watch mode.
 */

import { join } from 'node:path';

import { $ } from 'bun';

import { loadConfig, LOCAL_DEFAULTS } from '../src/config';
import { createDynamoClient } from '../src/dynamodb';
import { ensureUsageTable, waitForDynamo } from '../src/usage.table';

const PACKAGE_DIR = join(import.meta.dir, '..');
const env = {
  ...process.env,
  APP_ENV: 'development',
  CLI_USAGE_DYNAMODB_ENDPOINT: LOCAL_DEFAULTS.dynamodbEndpoint,
};
const config = loadConfig(env);

await $`docker compose -p canyonos-cli-usage -f ${join(PACKAGE_DIR, 'docker-compose.yml')} up -d`;

const client = createDynamoClient(config);
await waitForDynamo(client);
const table = await ensureUsageTable(client, config.tableName);
client.destroy();

const url = `http://127.0.0.1:${config.port}`;
console.info(`
DynamoDB Local: ${config.dynamodb.kind === 'local' ? config.dynamodb.endpoint : 'aws'} (table ${config.tableName}, ${table})
CLI usage API:  ${url}/usage/events
Point the dev CLI at it with: export CANYONOS_USAGE_URL=${url}
Stop with Ctrl-C; \`bun run cli:usage:reset\` stops DynamoDB Local and deletes its data.
`);

const server = Bun.spawn(['bun', 'run', 'dev:server'], {
  cwd: PACKAGE_DIR,
  env,
  stdio: ['inherit', 'inherit', 'inherit'],
});
process.exit(await server.exited);
