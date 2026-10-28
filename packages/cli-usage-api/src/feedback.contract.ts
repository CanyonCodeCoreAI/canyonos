// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The contract of `POST /feedback`: the message a user sends with `canyonos feedback`, and what
 * the API answers once it is stored.
 */

import { z } from 'zod';

import { CliVersionSchema, UuidV4Schema } from './usage.contract';

export const MAX_FEEDBACK_MESSAGE_LENGTH = 4000;
const MAX_PLATFORM_LENGTH = 64;

export const FeedbackSchema = z
  .object({
    feedback_id: UuidV4Schema,
    message: z.string().min(1).max(MAX_FEEDBACK_MESSAGE_LENGTH),
    cli_version: CliVersionSchema,
    os: z.string().max(MAX_PLATFORM_LENGTH),
    arch: z.string().max(MAX_PLATFORM_LENGTH),
    // Sent only while usage reporting is on, so feedback can be matched to usage events.
    installation_id: UuidV4Schema.optional(),
  })
  .strict();

export const FeedbackStoredSchema = z.object({ stored: z.boolean() });

export type Feedback = z.infer<typeof FeedbackSchema>;
export type FeedbackStored = z.infer<typeof FeedbackStoredSchema>;
