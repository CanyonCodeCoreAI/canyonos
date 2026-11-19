// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

/** A client certificate the workflow group's CA signed, with that CA, all PEM: a Docker
 * workflow group's Redis takes only TLS clients that present one. */
export const RedisClientTlsSchema = z.object({
  ca: z.string().min(1),
  cert: z.string().min(1),
  key: z.string().min(1),
});

// Only a CanyonOS workflow group's Redis container: the api never connects to a host the caller
// chooses freely.
export const RedisContainerHostSchema = z.string().regex(/^canyonos-[a-z0-9_-]+-redis-localhost$/);

export const RedisPortSchema = z.number().int().min(1).max(65535);

/** What `canyonos deploy` registers of a Docker workflow group, before its Global Controller
 * starts: each workflow's name by its workflow_id, and how the api reaches and signs in to the
 * group's Redis. */
export const WorkflowGroupRegistrationSchema = z.object({
  workflows: z.record(z.string().uuid(), z.string().min(1)),
  redis_host: RedisContainerHostSchema,
  redis_port: RedisPortSchema,
  redis_password: z.string(),
  redis_tls: RedisClientTlsSchema.nullable(),
});

export const RegisteredWorkflowSchema = z.object({
  workflow_id: z.string().uuid(),
  name: z.string(),
});

export type RedisClientTls = z.infer<typeof RedisClientTlsSchema>;
export type WorkflowGroupRegistration = z.infer<typeof WorkflowGroupRegistrationSchema>;
export type RegisteredWorkflow = z.infer<typeof RegisteredWorkflowSchema>;
