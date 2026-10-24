// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The contract of `POST /usage/events`: the batch of command outcomes the `canyonos` CLI reports,
 * and what the API answers once every event in it is stored.
 */

import { z } from 'zod';

/**
 * The `canyonos` commands whose outcome is reported: the ones that act on an app or its
 * workflow. Help, version, `status`, `logs`, `config`, `doctor` and the consent commands only
 * show or set local state, so they are never reported.
 */
export const REPORTED_COMMANDS = [
  'new-app',
  'convert',
  'validate',
  'deploy',
  'test',
  'serve',
  'stop',
  'clean',
  'quit',
  // Events from before `build` was renamed `convert`.
  'build',
] as const;

export const MAX_EVENTS_PER_BATCH = 25;
export const MAX_REQUEST_BODY_BYTES = 16 * 1024;
const MAX_CLI_VERSION_LENGTH = 64;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEMVER_LIKE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;

const UuidV4Schema = z.string().regex(UUID_V4, 'Expected a lowercase UUID v4');

export const UsageEventSchema = z
  .object({
    event_id: UuidV4Schema,
    installation_id: UuidV4Schema,
    command: z.enum(REPORTED_COMMANDS),
    succeeded: z.boolean(),
    occurred_at: z.string().datetime({ message: 'Expected an ISO-8601 UTC datetime' }),
    cli_version: z
      .string()
      .max(MAX_CLI_VERSION_LENGTH)
      .regex(SEMVER_LIKE, 'Expected a version such as 1.2.3'),
  })
  .strict();

export const UsageEventBatchSchema = z
  .object({
    events: z.array(UsageEventSchema).min(1).max(MAX_EVENTS_PER_BATCH),
  })
  .strict();

export const UsageEventsStoredSchema = z.object({
  stored: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
});

export type UsageEvent = z.infer<typeof UsageEventSchema>;
export type UsageEventBatch = z.infer<typeof UsageEventBatchSchema>;
export type UsageEventsStored = z.infer<typeof UsageEventsStoredSchema>;
