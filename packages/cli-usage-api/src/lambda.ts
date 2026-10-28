// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The deployed entry point: an AWS Lambda behind CloudFront, reached through its function URL,
 * that serves the CLI usage API. The configuration is checked when the Lambda starts, before the
 * first request.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

import { createApp } from './app';
import { loadConfig } from './config';
import { createDynamoClient } from './dynamodb';
import { createFeedbackRepository } from './feedback.repository';
import { toRequest, toResult } from './lambda.adapter';
import { createUsageRepository } from './usage.repository';

const config = loadConfig();
if (config.environment !== 'production') {
  throw new Error(`The Lambda serves production only; APP_ENV is ${config.environment}.`);
}
const client = createDynamoClient(config);
const app = createApp({
  repository: createUsageRepository(client, config.tableName),
  feedbackRepository: createFeedbackRepository(client, config.feedbackTableName),
});

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> => toResult(await app.handle(toRequest(event)));
