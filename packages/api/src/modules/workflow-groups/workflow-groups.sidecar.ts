// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { config } from '@core/env';
import { badGateway } from '@core/errors';

import { core_failed, parse_answer } from './workflow-groups.core';
import type { CoreReply } from './workflow-groups.core';

// On Kubernetes the API pod's `core` sidecar runs the `canyonos_core.cli` commands, from a file
// queue on the /workspace emptyDir both containers mount: no exec, no network listener, no
// cluster rights. A request is `.canyonos/jobs/<id>.json` (written whole: a temporary file, then
// a rename), the sidecar's answer `<id>.out.json`; it runs the command with cwd
// /workspace/<workflow_group_id>, so each workflow group's upload stays in its own folder.

const RUNNER = "The API's core sidecar";
const POLL_MS = 100;
// How much longer than its own timeout the sidecar may take to answer a request.
const ANSWER_SLACK_SECONDS = 15;

const AnswerSchema = z.object({
  exit_code: z.number().int(),
  // The command's one JSON object, or its stdout as text.
  stdout: z.unknown(),
  stderr_tail: z.string().default(''),
});

const canyonos_dir = () => join(config.kubernetes.workspaceDir, '.canyonos');
const jobs_dir = () => join(canyonos_dir(), 'jobs');

/** The folder a workflow group's upload is in, which its commands run in. */
export const group_dir = (workflow_group_id: string) =>
  join(config.kubernetes.workspaceDir, workflow_group_id);

/** Where an upload waits for its `put-workflow`, outside every workflow group's folder. */
export const uploads_dir = () => join(canyonos_dir(), 'uploads');

/** Where a workflow group's workspace is bundled for its build pod. */
export const bundle_path = (workflow_group_id: string) =>
  join(canyonos_dir(), 'bundles', `${workflow_group_id}.tar.gz`);

/** The `canyonos-core` version the sidecar runs, which it writes as it starts; null before. */
export async function core_version(): Promise<string | null> {
  const file = Bun.file(join(canyonos_dir(), 'core-version'));
  if (!(await file.exists())) return null;
  return (await file.text()).trim() || null;
}

/** Writes `text` to `path` whole: a reader sees the old file or the new one, never part. */
export async function write_whole(path: string, text: string): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await Bun.write(temporary, text);
  await rename(temporary, path);
}

export interface SidecarJob {
  workflow_group_id: string;
  /** The `canyonos_core.cli` subcommand and its arguments. */
  command: string[];
  timeout_seconds: number;
  /** Its answer holds secrets, such as `.env` values: no error or log shows what it printed. */
  secret?: boolean;
}

/** Runs a `canyonos_core.cli` command in the core sidecar, in the workflow group's folder, and
 * returns what it answered; 502 when the sidecar did not answer in time. */
export async function run_sidecar_job({
  workflow_group_id,
  command,
  timeout_seconds,
  secret = false,
}: SidecarJob): Promise<CoreReply> {
  const id = crypto.randomUUID();
  const subcommand = command[0]!;
  await mkdir(jobs_dir(), { recursive: true });
  await mkdir(group_dir(workflow_group_id), { recursive: true });
  const request = join(jobs_dir(), `${id}.json`);
  const answer_path = join(jobs_dir(), `${id}.out.json`);
  await write_whole(request, JSON.stringify({ id, workflow_group_id, command, timeout_seconds }));
  const deadline = Date.now() + (timeout_seconds + ANSWER_SLACK_SECONDS) * 1000;
  try {
    for (;;) {
      const file = Bun.file(answer_path);
      if (await file.exists()) {
        const parsed = AnswerSchema.safeParse(JSON.parse(await file.text()));
        if (!parsed.success) {
          throw core_failed(RUNNER, subcommand, -1, 'its answer file does not match its schema');
        }
        const { exit_code, stdout, stderr_tail } = parsed.data;
        const printed = typeof stdout === 'string' ? stdout : JSON.stringify(stdout ?? null);
        if (secret) {
          try {
            return parse_answer(RUNNER, subcommand, exit_code, printed, '');
          } catch {
            throw core_failed(RUNNER, subcommand, exit_code, stderr_tail);
          }
        }
        return parse_answer(RUNNER, subcommand, exit_code, printed, stderr_tail);
      }
      if (Date.now() > deadline) {
        throw badGateway(
          'workflow_groups.controller_failed',
          `${RUNNER} did not answer \`${subcommand}\` within ${timeout_seconds + ANSWER_SLACK_SECONDS} seconds: is its \`core\` container running?`
        );
      }
      await Bun.sleep(POLL_MS);
    }
  } finally {
    await Promise.all([rm(request, { force: true }), rm(answer_path, { force: true })]);
  }
}
