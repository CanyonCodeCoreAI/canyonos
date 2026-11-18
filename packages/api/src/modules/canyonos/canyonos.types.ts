// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

/** A client certificate the deployment's CA signed, with that CA, all PEM: a Docker
 * deployment's Redis takes only TLS clients that present one. */
export const RedisClientTlsSchema = z.object({
  ca: z.string().min(1),
  cert: z.string().min(1),
  key: z.string().min(1),
});

export const RegisterProjectBody = z.object({
  redis_host: z
    .string()
    .regex(/^canyonos-[a-z0-9_-]+-redis-localhost$/)
    .optional(),
  redis_port: z.number().int().min(1).max(65535),
  redis_password: z.string().default(''),
  redis_tls: RedisClientTlsSchema.optional(),
});

export const RegisteredProjectSchema = z.object({
  project_id: z.string().uuid(),
  name: z.string(),
});

export type RedisClientTls = z.infer<typeof RedisClientTlsSchema>;
export type RegisterProject = z.infer<typeof RegisterProjectBody>;
export type RegisteredProject = z.infer<typeof RegisteredProjectSchema>;
