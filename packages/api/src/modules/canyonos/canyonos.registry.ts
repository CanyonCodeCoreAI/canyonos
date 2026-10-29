// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync, statSync } from 'node:fs';

import { z } from 'zod';

import { config } from '@core/env';
import { LOG_DOMAINS, logger } from '@core/logger';

// On Kubernetes one dashboard serves every project, each with its own Redis. The
// CanyonOS operator lists them, with how to reach and sign in to each Redis, in a
// Secret the dashboard mounts as a file (CANYONOS_PROJECTS_FILE); nothing posts
// registrations. On Docker there is no file and nothing here changes.

const RegisteredRedis = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  tls: z.boolean().default(false),
  username: z.string().default(''),
  password: z.string().default(''),
});

const RegistryEntrySchema = z.object({
  project_id: z.string().uuid(),
  name: z.string().min(1),
  redis: RegisteredRedis,
});

const RegistryFileSchema = z.object({ projects: z.array(RegistryEntrySchema) });

export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

const registry_logger = logger.child({ domain: LOG_DOMAINS.DB });

interface Cached {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly entries: Map<string, RegistryEntry>;
}

let cached: Cached | null = null;

/** The projects listed in the registry file, by project id; empty without a file. The file
 * is read again when it changes (a mounted Secret is replaced, not edited in place). */
export function registered_projects(
  path: string | null = config.canyonos.projectsFile
): Map<string, RegistryEntry> {
  if (!path) return new Map();
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return new Map();
  }
  if (cached?.path === path && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.entries;
  }
  try {
    const parsed = RegistryFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    const entries = new Map(parsed.projects.map((entry) => [entry.project_id, entry]));
    cached = { path, mtimeMs: stat.mtimeMs, size: stat.size, entries };
    return entries;
  } catch (error) {
    // A half-written or broken file keeps the last good list rather than losing every project.
    registry_logger.warn('Could not read the projects registry', { error, path });
    return cached?.path === path ? cached.entries : new Map();
  }
}

/** For tests: forget what was read. */
export function forget_registry(): void {
  cached = null;
}
