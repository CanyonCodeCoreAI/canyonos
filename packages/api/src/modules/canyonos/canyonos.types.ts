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

export const RegisterWorkflowBody = z.object({
  redis_host: z
    .string()
    .regex(/^canyonos-[a-z0-9_-]+-redis-localhost$/)
    .optional(),
  redis_port: z.number().int().min(1).max(65535),
  redis_password: z.string().default(''),
  redis_tls: RedisClientTlsSchema.optional(),
});

export const RegisteredWorkflowSchema = z.object({
  workflow_id: z.string().uuid(),
  name: z.string(),
});

export const RegisteredWorkflowsSchema = z.object({ workflows: z.array(RegisteredWorkflowSchema) });

export type RedisClientTls = z.infer<typeof RedisClientTlsSchema>;
export type RegisterWorkflow = z.infer<typeof RegisterWorkflowBody>;
export type RegisteredWorkflow = z.infer<typeof RegisteredWorkflowSchema>;
