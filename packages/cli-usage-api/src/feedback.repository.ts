// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stores feedback in DynamoDB, one item per `feedback_id`. A resent feedback keeps the first
 * copy.
 */

import { putIfAbsent } from './usage.repository';
import type { Feedback, FeedbackStored } from './feedback.contract';
import type { PutItemSender } from './usage.repository';

export const FEEDBACK_TABLE_PARTITION_KEY = 'feedback_id';

export interface FeedbackRepository {
  storeFeedback(feedback: Feedback, receivedAt: string): Promise<FeedbackStored>;
}

const toItem = (feedback: Feedback, receivedAt: string) => ({
  feedback_id: { S: feedback.feedback_id },
  message: { S: feedback.message },
  cli_version: { S: feedback.cli_version },
  os: { S: feedback.os },
  arch: { S: feedback.arch },
  ...(feedback.installation_id ? { installation_id: { S: feedback.installation_id } } : {}),
  received_at: { S: receivedAt },
});

/** Build the repository over `client` and `tableName`. */
export function createFeedbackRepository(
  client: PutItemSender,
  tableName: string
): FeedbackRepository {
  return {
    async storeFeedback(feedback, receivedAt) {
      const outcome = await putIfAbsent(
        client,
        tableName,
        FEEDBACK_TABLE_PARTITION_KEY,
        toItem(feedback, receivedAt)
      );
      return { stored: outcome === 'stored' };
    },
  };
}
