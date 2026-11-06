// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stores feedback in S3, one object per `feedback_id` under `feedback/`. A resent feedback keeps
 * the first copy.
 */

import { PutObjectCommand, S3ServiceException } from '@aws-sdk/client-s3';
import type { PutObjectCommandOutput } from '@aws-sdk/client-s3';

import type { Feedback, FeedbackStored } from './feedback.contract';

export interface PutObjectSender {
  send(command: PutObjectCommand): Promise<PutObjectCommandOutput>;
}

export interface FeedbackRepository {
  storeFeedback(feedback: Feedback, receivedAt: string): Promise<FeedbackStored>;
}

/** Build the repository over `client` and `bucketName`. */
export function createFeedbackRepository(
  client: PutObjectSender,
  bucketName: string
): FeedbackRepository {
  return {
    async storeFeedback(feedback, receivedAt) {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucketName,
            Key: `feedback/${feedback.feedback_id}.json`,
            Body: JSON.stringify({ ...feedback, received_at: receivedAt }),
            ContentType: 'application/json',
            IfNoneMatch: '*',
          })
        );
        return { stored: true };
      } catch (error) {
        // S3 answers 412 when an object with this key already exists.
        if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412) {
          return { stored: false };
        }
        throw error;
      }
    },
  };
}
