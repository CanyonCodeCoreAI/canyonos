// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

export const HealthSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  timestamp: z.string(),
});
export type Health = z.infer<typeof HealthSchema>;

/** `ok` once migrated and answering; before that, where the API is in readying it. */
export const DatabaseCheckSchema = z.enum([
  'ok',
  'connecting',
  'migrating',
  'failed',
  'unreachable',
]);
export type DatabaseCheck = z.infer<typeof DatabaseCheckSchema>;

/** `disabled` is an API that runs without Docker (DOCKER_SOCKET empty); none of the three
 * holds readiness back. */
export const DockerCheckSchema = z.enum(['ok', 'disabled', 'unreachable']);
export type DockerCheck = z.infer<typeof DockerCheckSchema>;

export const ReadinessSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.object({ database: DatabaseCheckSchema, docker: DockerCheckSchema }),
});
export type Readiness = z.infer<typeof ReadinessSchema>;
