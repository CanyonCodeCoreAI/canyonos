// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The usage events and feedback tables as `cli:usage:dev` and the end-to-end tests create them in
 * DynamoDB Local. The deployed tables are provisioned by infrastructure with the same keys.
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
 * Create the table when it is missing, or check that the existing one is keyed on the string
 * `partitionKey`. Returns whether the table was created; throws when an existing table has another
 * key, which `cli:usage:reset` clears.
 */
export async function ensureTable(
  client: DynamoDBClient,
  tableName: string,
  partitionKey: string
): Promise<'created' | 'existing'> {
  try {
    const { Table } = await client.send(new DescribeTableCommand({ TableName: tableName }));
    const key = Table?.KeySchema ?? [];
    const attribute = Table?.AttributeDefinitions?.find(
      (definition) => definition.AttributeName === partitionKey
    );
    const keyedOnPartitionKey =
      key.length === 1 &&
      key[0]?.AttributeName === partitionKey &&
      key[0].KeyType === 'HASH' &&
      attribute?.AttributeType === 'S';
    if (!keyedOnPartitionKey) {
      throw new Error(
        `Table ${tableName} exists but is not keyed on the string ${partitionKey}; ` +
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
      AttributeDefinitions: [{ AttributeName: partitionKey, AttributeType: 'S' }],
      KeySchema: [{ AttributeName: partitionKey, KeyType: 'HASH' }],
    })
  );
  await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName });
  return 'created';
}
