// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Serves the CLI usage API on the loopback interface for local development and the end-to-end
 * tests, against the moto server the configuration points at.
 */

import { createApp } from './app';
import { createAwsClients } from './aws';
import { loadConfig } from './config';
import { createFeedbackRepository } from './feedback.repository';
import { createUsageRepository } from './usage.repository';

const config = loadConfig();
const clients = createAwsClients(config);
const app = createApp({
  repository: createUsageRepository(clients.firehose, config.streamName),
  feedbackRepository: createFeedbackRepository(clients.s3, config.feedbackBucketName),
});
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: config.port,
  fetch: (request) => app.handle(request),
});

console.info(`CLI usage API listening on ${server.url.origin} (APP_ENV=${config.environment})`);
