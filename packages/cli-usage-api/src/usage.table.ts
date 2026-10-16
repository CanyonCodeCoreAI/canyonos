// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The usage events table as `cli:usage:dev` and the end-to-end tests create it in DynamoDB Local.
 * The deployed table is provisioned by infrastructure with the same key.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import {
  CreateTableCommand,
  DescribeTableCommand,
  ListTablesCommand,
  ResourceNotFoundException,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';

import { USAGE_TABLE_PARTITION_KEY } from './usage.repository';

/** Poll DynamoDB until it answers, or throw once `timeoutMs` has passed. */
export async function waitForDynamo(client: DynamoDBClient, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await client.send(new ListTablesCommand({ Limit: 1 }));
      return;
    } catch (error) {
      if (Date.now() > deadline) {
        throw new Error(`DynamoDB did not answer within ${timeoutMs} ms`, { cause: error });
      }
      await sleep(250);
    }
  }
}

/**
 * Create the usage events table when it is missing, or check that the existing one is keyed on
 * `event_id`. Returns whether the table was created; throws when an existing table has another
 * key, which `cli:usage:reset` clears.
 */
export async function ensureUsageTable(
  client: DynamoDBClient,
  tableName: string
): Promise<'created' | 'existing'> {
  try {
    const { Table } = await client.send(new DescribeTableCommand({ TableName: tableName }));
    const key = Table?.KeySchema ?? [];
    const attribute = Table?.AttributeDefinitions?.find(
      (definition) => definition.AttributeName === USAGE_TABLE_PARTITION_KEY
    );
    const keyedOnEventId =
      key.length === 1 &&
      key[0]?.AttributeName === USAGE_TABLE_PARTITION_KEY &&
      key[0].KeyType === 'HASH' &&
      attribute?.AttributeType === 'S';
    if (!keyedOnEventId) {
      throw new Error(
        `Table ${tableName} exists but is not keyed on the string ${USAGE_TABLE_PARTITION_KEY}; ` +
          'run `bun run cli:usage:reset` to recreate it.'
      );
    }
    return 'existing';
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) throw error;
  }
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: USAGE_TABLE_PARTITION_KEY, AttributeType: 'S' }],
      KeySchema: [{ AttributeName: USAGE_TABLE_PARTITION_KEY, KeyType: 'HASH' }],
    })
  );
  await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName });
  return 'created';
}
