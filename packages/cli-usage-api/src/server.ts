// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Serves the CLI usage API on the loopback interface for local development and the end-to-end
 * tests, against the DynamoDB Local the configuration points at.
 */

import { createApp } from './app';
import { loadConfig } from './config';
import { createDynamoClient } from './dynamodb';
import { createFeedbackRepository } from './feedback.repository';
import { createUsageRepository } from './usage.repository';

const config = loadConfig();
const client = createDynamoClient(config);
const app = createApp({
  repository: createUsageRepository(client, config.tableName),
  feedbackRepository: createFeedbackRepository(client, config.feedbackTableName),
});
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: config.port,
  fetch: (request) => app.handle(request),
});

console.info(`CLI usage API listening on ${server.url.origin} (APP_ENV=${config.environment})`);
