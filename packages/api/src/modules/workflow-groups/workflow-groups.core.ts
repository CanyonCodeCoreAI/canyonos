// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

import { badGateway } from '@core/errors';
import type { AppError } from '@core/errors';

// What a `canyonos_core.cli` command answers, on either target: one JSON object on stdout and
// its exit code. Docker runs the commands in the Global Controller container or a job container
// of its image, Kubernetes in the API pod's core sidecar.

const OUTPUT_TAIL_CHARACTERS = 500;

/** Who ran a command, as an error names it. */
export type CoreRunner = "The Global Controller's core" | "The API's core sidecar";

export interface CoreReply {
  runner: CoreRunner;
  command: string;
  exit_code: number;
  answer: Record<string, unknown>;
}

export function core_failed(
  runner: CoreRunner,
  command: string,
  exit_code: number,
  output: string
): AppError {
  return badGateway(
    'workflow_groups.controller_failed',
    `${runner} could not run \`${command}\` (exit code ${exit_code}): ` +
      (output.trim().slice(-OUTPUT_TAIL_CHARACTERS) || 'it printed nothing')
  );
}

/** The reply of a command that printed `stdout`; anything but one JSON object is a crash,
 * explained on `stderr`. */
export function parse_answer(
  runner: CoreRunner,
  command: string,
  exit_code: number,
  stdout: string,
  stderr: string
): CoreReply {
  let answer: unknown;
  try {
    answer = JSON.parse(stdout);
  } catch {
    answer = undefined;
  }
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) {
    throw core_failed(runner, command, exit_code, stderr.trim() || stdout);
  }
  return { runner, command, exit_code, answer: answer as Record<string, unknown> };
}

const CoreErrorSchema = z.object({ error: z.string() });

/** Core's own explanation of a failure, when it exited with `exit_code` and gave one. */
export function core_error(reply: CoreReply, exit_code: number): string | null {
  if (reply.exit_code !== exit_code) return null;
  const parsed = CoreErrorSchema.safeParse(reply.answer);
  return parsed.success ? parsed.data.error : null;
}

/** The answer of a command that succeeded, as `schema` reads it. */
export function core_answer<T>(reply: CoreReply, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(reply.answer);
  if (reply.exit_code !== 0 || !parsed.success) {
    throw core_failed(reply.runner, reply.command, reply.exit_code, JSON.stringify(reply.answer));
  }
  return parsed.data;
}
