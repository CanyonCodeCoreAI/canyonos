// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Subprocess } from 'bun';

import { until_answers } from './test.utils';

// What the E2E files run outside the suite's own API: Docker commands, stand-in Global
// Controllers, and more APIs started as the image starts one, each on a free port.

const SERVER = new URL('../server.ts', import.meta.url).pathname;
const READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;

/** Runs `docker args`, resolving to its trimmed stdout; a failed command throws with its stderr. */
export async function docker(args: string[]): Promise<string> {
  const child = Bun.spawn(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit_code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit_code !== 0) throw new Error(`docker ${args.join(' ')} failed: ${stderr}`);
  return stdout.trim();
}

/** The core image the /v1 tests run Global Controllers and job containers from. Unset, the
 * test file fails rather than skips: CI must run it. */
export function core_image(): string {
  const image = Bun.env.CANYONOS_CORE_IMAGE;
  if (!image) {
    throw new Error(
      'Set CANYONOS_CORE_IMAGE to the core image to test /v1/workflow-groups against, e.g. one ' +
        'built with `docker build -f packages/core/Dockerfile -t canyonos-core:dev .`'
    );
  }
  return image;
}

export interface FakeController {
  /** The Compose project of the workflow group, as `canyonos deploy` names it. */
  readonly project: string;
  readonly workflow_group_id: string;
  /** What the container runs, as `sh -c`, in the core image. */
  readonly script: string;
  /** Created and left stopped when false. */
  readonly start?: boolean;
}

/** A stand-in Global Controller, labelled the way `canyonos deploy` labels one, that runs
 * `script` in the core image. Resolves to the container id. */
export async function create_fake_controller({
  project,
  workflow_group_id,
  script,
  start = true,
}: FakeController): Promise<string> {
  const id = await docker([
    'create',
    '--init',
    '--label',
    `com.docker.compose.project=${project}`,
    '--label',
    'canyonos.role=global-controller',
    '--label',
    `canyonos.workflow_group_id=${workflow_group_id}`,
    '--entrypoint',
    'sh',
    core_image(),
    '-c',
    script,
  ]);
  if (start) await docker(['start', id]);
  return id;
}

/** A port nothing listens on right now. */
export function free_port(): number {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => undefined } });
  const { port } = probe;
  probe.stop(true);
  return port;
}

/** An API that exited before it was ready, with what it printed. */
export class ApiExited extends Error {
  constructor(
    readonly exit_code: number | null,
    readonly output: string
  ) {
    super(`The API exited with code ${exit_code} before it was ready:\n${output}`);
  }
}

export interface SpawnedApi {
  readonly url: string;
  readonly port: number;
  /** What it printed so far, stdout and stderr. */
  output(): string;
  /** SIGTERM, then SIGKILL after STOP_TIMEOUT_MS; resolves to the exit code. */
  stop(): Promise<number | null>;
}

const running = new Set<Subprocess>();
process.on('exit', () => {
  for (const child of running) child.kill('SIGKILL');
});

/** Reads `streams` as they arrive: `text()` is what came so far, `done` settles when they close. */
function collect(streams: ReadableStream<Uint8Array>[]) {
  let text = '';
  const decoder = new TextDecoder();
  const done = Promise.all(
    streams.map((stream) =>
      stream.pipeTo(
        new WritableStream({
          write: (chunk) => void (text += decoder.decode(chunk, { stream: true })),
        })
      )
    )
  );
  return { text: () => text, done };
}

export interface SpawnOptions {
  /** The path that answers 200 once it is ready. */
  readonly ready?: '/healthz' | '/readyz';
  readonly timeout_ms?: number;
}

async function start_once(
  env: Record<string, string>,
  { ready = '/readyz', timeout_ms = READY_TIMEOUT_MS }: SpawnOptions
): Promise<SpawnedApi> {
  const port = free_port();
  const url = `http://127.0.0.1:${port}`;
  // This run's Bun, so a run on CI's version starts the APIs on it too.
  const child = Bun.spawn([process.execPath, '--no-env-file', SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      API_URL: url,
      // No workflow group runs here: the suite's API holds the Docker tests.
      DOCKER_SOCKET: '',
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  running.add(child);
  const output = collect([child.stdout, child.stderr]);

  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const killer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
    const exit_code = await child.exited;
    clearTimeout(killer);
    running.delete(child);
    return exit_code;
  };

  const exited = child.exited.then(async (exit_code) => {
    running.delete(child);
    await output.done;
    throw new ApiExited(exit_code, output.text());
  });
  // Settles once it exits, which a started API only does when stopped.
  exited.catch(() => undefined);
  try {
    await Promise.race([until_answers(url, ready, timeout_ms), exited]);
  } catch (error) {
    await stop();
    if (error instanceof ApiExited) throw error;
    throw new Error(`${String(error)}\n${output.text()}`, { cause: error });
  }
  return { url, port, output: output.text, stop };
}

/** Starts `src/server.ts` as the image does, on a free port, with `env` over this run's
 * environment and Docker off unless `env` names a socket, and resolves once `ready` answers 200.
 * One that exits first rejects with ApiExited; one that lost its port to another process is
 * started once more on another. */
export async function spawn_api(
  env: Record<string, string> = {},
  options: SpawnOptions = {}
): Promise<SpawnedApi> {
  try {
    return await start_once(env, options);
  } catch (error) {
    if (!(error instanceof ApiExited) || !error.output.includes('EADDRINUSE')) throw error;
    return start_once(env, options);
  }
}

/** The exit code and output of an API that must exit before it is ready. */
export async function refused_start(
  env: Record<string, string>,
  timeout_ms = READY_TIMEOUT_MS
): Promise<ApiExited> {
  const api = await spawn_api(env, { timeout_ms }).catch((error: unknown) => {
    if (error instanceof ApiExited) return error;
    throw error;
  });
  if (api instanceof ApiExited) return api;
  await api.stop();
  throw new Error(`The API started with ${JSON.stringify(env)}:\n${api.output()}`);
}
