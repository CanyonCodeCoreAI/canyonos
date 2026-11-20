// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { config } from './env';
import {
  AppError,
  badGateway,
  conflict,
  gatewayTimeout,
  notFound,
  serviceUnavailable,
} from './errors';

// The oldest Engine API Docker 29 still serves; Docker 25 and later speak it.
const DOCKER_API = 'http://docker/v1.44';
const REQUEST_TIMEOUT_MS = 30_000;
const PING_TIMEOUT_MS = 1_000;
const EXEC_POLL_MS = 50;
const STDOUT_STREAM = 1;
const STDERR_STREAM = 2;
const FRAME_HEADER_BYTES = 8;
// What Docker reports as the start time of a container that was never started.
const NEVER_STARTED = '0001-01-01T00:00:00Z';

export interface ContainerMount {
  type: string;
  /** The volume's name, or a bind mount's host path. */
  source: string;
  destination: string;
}

export interface Container {
  id: string;
  name: string;
  /** The id of the image the container was created from. */
  image_id: string;
  labels: Record<string, string>;
  /** Docker's state: created, running, paused, restarting, removing, exited or dead. */
  status: string;
  running: boolean;
  exit_code: number;
  /** When the container last started, in epoch milliseconds; null when it never started. */
  started_at_ms: number | null;
  mounts: ContainerMount[];
  /** The name of each network the container is on. */
  networks: string[];
}

export interface ExecResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

export interface LogsOptions {
  stdout?: boolean;
  stderr?: boolean;
  /** How many lines from the end, or `all`. */
  tail?: string;
  /** Only lines from this time on, in epoch milliseconds. */
  since_ms?: number | null;
}

/** What `POST /containers/create` takes; only the fields this API sets. */
export interface ContainerSpec {
  Image: string;
  Entrypoint?: string[];
  Cmd?: string[];
  WorkingDir?: string;
  Labels?: Record<string, string>;
  HostConfig?: { Binds?: string[]; NetworkMode?: string };
}

interface DockerContainerSummary {
  Id: string;
  Labels: Record<string, string> | null;
}

interface DockerContainerDetails {
  Id: string;
  Name: string;
  Image: string;
  Config: { Labels: Record<string, string> | null };
  State: { Status: string; Running: boolean; ExitCode: number; StartedAt: string };
  Mounts: { Type: string; Name?: string; Source: string; Destination: string }[] | null;
  NetworkSettings: { Networks: Record<string, unknown> | null } | null;
}

interface DockerExecDetails {
  Running: boolean;
  ExitCode: number | null;
}

interface DockerRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** JSON, or a tar archive as bytes. */
  body?: unknown;
  /** Bounds the whole answer; null for a stream that may stay open, such as a followed log. */
  timeout_ms?: number | null;
  signal?: AbortSignal;
}

function socket(): string {
  if (config.docker.socket === null) {
    throw serviceUnavailable(
      'docker.disabled',
      'This API runs without Docker: DOCKER_SOCKET is empty, so it drives no workflow group here'
    );
  }
  return config.docker.socket;
}

function unreachable(error: unknown, timeout_ms: number | null): AppError {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return gatewayTimeout(
      'docker.timeout',
      `Docker did not answer within ${(timeout_ms ?? 0) / 1000} seconds`,
      { cause: error }
    );
  }
  const reason = error instanceof Error ? error.message : String(error);
  return serviceUnavailable(
    'docker.unavailable',
    `Could not reach Docker at ${config.docker.socket}: ${reason}`,
    { cause: error }
  );
}

function daemon_message(text: string): string {
  try {
    return (JSON.parse(text) as { message?: string }).message ?? text;
  } catch {
    return text;
  }
}

async function daemon_error(response: Response): Promise<AppError> {
  const message = daemon_message(await response.text());
  if (response.status === 404) return notFound('docker.not_found', message);
  if (response.status === 409) return conflict('docker.conflict', message);
  return badGateway('docker.error', `Docker answered ${response.status}: ${message}`);
}

function request_body(body: unknown): { headers?: Record<string, string>; body?: BodyInit } {
  if (body === undefined) return {};
  if (body instanceof Uint8Array) {
    return {
      headers: { 'content-type': 'application/x-tar' },
      body: body as Uint8Array<ArrayBuffer>,
    };
  }
  return { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** Sends one Engine API request; `read` reads the answer of a 2xx, or of a 304, which Docker
 * sends for a container already in the state asked for. */
async function docker_request<T>(
  path: string,
  read: (response: Response) => Promise<T>,
  { method = 'GET', body, timeout_ms = REQUEST_TIMEOUT_MS, signal }: DockerRequest = {}
): Promise<T> {
  const unix = socket();
  const signals = [
    ...(timeout_ms === null ? [] : [AbortSignal.timeout(timeout_ms)]),
    ...(signal ? [signal] : []),
  ];
  try {
    const response = await fetch(`${DOCKER_API}${path}`, {
      method,
      unix,
      signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
      ...request_body(body),
    });
    if (!response.ok && response.status !== 304) throw await daemon_error(response);
    return await read(response);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw unreachable(error, timeout_ms);
  }
}

const json = <T>(response: Response) => response.json() as Promise<T>;
const drain = async (response: Response) => {
  await response.arrayBuffer();
};
const bytes = async (response: Response) => new Uint8Array(await response.arrayBuffer());
const container_path = (id: string) => `/containers/${encodeURIComponent(id)}`;

/** Splits the stream Docker multiplexes when no TTY is attached: each frame is a stream type
 * byte, three zero bytes and a big-endian uint32 payload length, then the payload. */
function demultiplex(frames: Uint8Array): { stdout: Uint8Array; stderr: Uint8Array } {
  const view = new DataView(frames.buffer, frames.byteOffset, frames.byteLength);
  const stdout_chunks: Uint8Array[] = [];
  const stderr_chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset + FRAME_HEADER_BYTES <= frames.byteLength) {
    const stream = frames[offset];
    const payload_start = offset + FRAME_HEADER_BYTES;
    const payload_end = payload_start + view.getUint32(offset + 4);
    const payload = frames.subarray(payload_start, payload_end);
    if (stream === STDOUT_STREAM) stdout_chunks.push(payload);
    if (stream === STDERR_STREAM) stderr_chunks.push(payload);
    offset = payload_end;
  }
  return { stdout: Buffer.concat(stdout_chunks), stderr: Buffer.concat(stderr_chunks) };
}

/** The payloads of a multiplexed stream as they arrive, stdout and stderr interleaved. */
function demultiplexing(): TransformStream<Uint8Array, Uint8Array> {
  let pending: Uint8Array = new Uint8Array(0);
  return new TransformStream({
    transform(chunk, controller) {
      pending = pending.byteLength === 0 ? chunk : Buffer.concat([pending, chunk]);
      let offset = 0;
      while (offset + FRAME_HEADER_BYTES <= pending.byteLength) {
        const length = new DataView(
          pending.buffer,
          pending.byteOffset + offset,
          FRAME_HEADER_BYTES
        ).getUint32(4);
        const payload_end = offset + FRAME_HEADER_BYTES + length;
        if (payload_end > pending.byteLength) break;
        if (length > 0) controller.enqueue(pending.slice(offset + FRAME_HEADER_BYTES, payload_end));
        offset = payload_end;
      }
      pending = pending.slice(offset);
    },
  });
}

const decode = (data: Uint8Array) => Buffer.from(data).toString('utf8');

/** Resolves when the daemon answers `GET /_ping` within PING_TIMEOUT_MS; what /v1/readyz asks. */
export function ping(): Promise<void> {
  return docker_request('/_ping', drain, { timeout_ms: PING_TIMEOUT_MS });
}

/** Every container, running or not, that carries all of `labels` (`key=value`), newest first. */
export async function list_containers(
  labels: string[]
): Promise<{ id: string; labels: Record<string, string> }[]> {
  const filters = encodeURIComponent(JSON.stringify({ label: labels }));
  const containers = await docker_request(
    `/containers/json?all=true&filters=${filters}`,
    json<DockerContainerSummary[]>
  );
  return containers.map(({ Id, Labels }) => ({ id: Id, labels: Labels ?? {} }));
}

export async function inspect(id_or_name: string): Promise<Container> {
  const { Id, Name, Image, Config, State, Mounts, NetworkSettings } = await docker_request(
    `${container_path(id_or_name)}/json`,
    json<DockerContainerDetails>
  );
  return {
    id: Id,
    name: Name.replace(/^\//, ''),
    image_id: Image,
    labels: Config.Labels ?? {},
    status: State.Status,
    running: State.Running,
    exit_code: State.ExitCode,
    started_at_ms: State.StartedAt === NEVER_STARTED ? null : Date.parse(State.StartedAt),
    mounts: (Mounts ?? []).map((mount) => ({
      type: mount.Type,
      source: mount.Type === 'volume' && mount.Name ? mount.Name : mount.Source,
      destination: mount.Destination,
    })),
    networks: Object.keys(NetworkSettings?.Networks ?? {}),
  };
}

/** Creates a container that has not started; returns its id. */
export async function create(spec: ContainerSpec): Promise<string> {
  const { Id } = await docker_request('/containers/create', json<{ Id: string }>, {
    method: 'POST',
    body: spec,
  });
  return Id;
}

/** Starts a created or exited container; one already running stays as it is. */
export function start(id: string): Promise<void> {
  return docker_request(`${container_path(id)}/start`, drain, { method: 'POST' });
}

/** Sends `signal` to the container's PID 1; 409 `docker.conflict` when it is not running. */
export function kill(id: string, signal: string): Promise<void> {
  return docker_request(`${container_path(id)}/kill?signal=${encodeURIComponent(signal)}`, drain, {
    method: 'POST',
  });
}

/** Waits until the container is not running, at most `timeout_ms`; returns its exit code. A
 * container that is not running answers at once. */
export async function wait(id: string, timeout_ms: number): Promise<number> {
  const { StatusCode } = await docker_request(
    `${container_path(id)}/wait?condition=not-running`,
    json<{ StatusCode: number }>,
    { method: 'POST', timeout_ms }
  );
  return StatusCode;
}

export function remove(id: string, { force }: { force: boolean }): Promise<void> {
  return docker_request(`${container_path(id)}?force=${force}`, drain, { method: 'DELETE' });
}

/** Whether Docker refused a connect because the container is on the network already: Docker 29
 * answers 403 "endpoint with name … already exists in network …" (`docker.error`) on API 1.44,
 * and an engine may answer 409 (`docker.conflict`) instead. */
function already_connected(error: unknown): boolean {
  return (
    error instanceof AppError &&
    (error.code === 'docker.error' || error.code === 'docker.conflict') &&
    error.message.includes('already exists in network')
  );
}

// The gateway priority a joined network gets, below the 0 of the network a container starts on.
// Docker routes a container's traffic through the network of highest priority, ties going to the
// name that sorts first; a joined network that took over would also move its published ports,
// cutting every connection through them, the request that asked for the join included. Docker 28
// added it, Docker 29 honours it on API 1.44 too, and an engine that predates it ignores it.
const JOINED_GATEWAY_PRIORITY = -1;

/** Connects the container to the network, at `gateway_priority`; one already on it stays as it
 * is. */
export async function connect_network(
  network: string,
  container: string,
  { gateway_priority = 0 }: { gateway_priority?: number } = {}
): Promise<void> {
  try {
    await docker_request(`/networks/${encodeURIComponent(network)}/connect`, drain, {
      method: 'POST',
      body: { Container: container, EndpointConfig: { GwPriority: gateway_priority } },
    });
  } catch (error) {
    if (!already_connected(error)) throw error;
  }
}

/** Connects the container to each of `networks` it is not on yet, none of them taking its
 * default gateway; returns those it joined. */
export async function join_networks(
  container: string,
  networks: readonly string[]
): Promise<string[]> {
  const { networks: current } = await inspect(container);
  const missing = networks.filter((network) => !current.includes(network));
  for (const network of missing) {
    await connect_network(network, container, { gateway_priority: JOINED_GATEWAY_PRIORITY });
  }
  return missing;
}

/** The tar archive Docker makes of `path` in the container, or null when there is none. */
export async function get_archive(id: string, path: string): Promise<Uint8Array | null> {
  try {
    return await docker_request(
      `${container_path(id)}/archive?path=${encodeURIComponent(path)}`,
      bytes
    );
  } catch (error) {
    if (error instanceof AppError && error.code === 'docker.not_found') return null;
    throw error;
  }
}

/** Unpacks `tar` into directory `path` of the container, which works before it first starts. */
export function put_archive(id: string, path: string, tar: Uint8Array): Promise<void> {
  return docker_request(`${container_path(id)}/archive?path=${encodeURIComponent(path)}`, drain, {
    method: 'PUT',
    body: tar,
  });
}

function logs_path(
  id: string,
  { stdout = true, stderr = true, tail = 'all', since_ms }: LogsOptions
) {
  const query = new URLSearchParams({
    stdout: String(stdout),
    stderr: String(stderr),
    tail,
    ...(since_ms ? { since: (since_ms / 1000).toFixed(3) } : {}),
  });
  return `${container_path(id)}/logs?${query}`;
}

/** The container's log so far, each stream on its own. */
export async function logs(
  id: string,
  options: LogsOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = demultiplex(await docker_request(logs_path(id, options), bytes));
  return { stdout: decode(stdout), stderr: decode(stderr) };
}

/** The container's log as a stream, stdout and stderr interleaved as written; with `follow`
 * it keeps streaming new lines until the container stops or `signal` aborts. */
export async function log_stream(
  id: string,
  { follow, ...options }: LogsOptions & { follow: boolean },
  signal?: AbortSignal
): Promise<ReadableStream<Uint8Array>> {
  const body = await docker_request(
    `${logs_path(id, options)}&follow=${follow}`,
    async (response) => response.body,
    { timeout_ms: follow ? null : REQUEST_TIMEOUT_MS, signal }
  );
  if (!body) return new ReadableStream({ start: (controller) => controller.close() });
  return body.pipeThrough(demultiplexing());
}

/** The exec's exit code once Docker has recorded it; the attached stream can close first. */
async function exec_exit_code(exec_id: string, deadline: number): Promise<number> {
  for (;;) {
    const details = await docker_request(`/exec/${exec_id}/json`, json<DockerExecDetails>);
    if (!details.Running && details.ExitCode !== null) return details.ExitCode;
    if (Date.now() >= deadline) {
      throw gatewayTimeout('docker.timeout', 'The command did not finish in time');
    }
    await Bun.sleep(EXEC_POLL_MS);
  }
}

/** Runs `cmd` in the running container `id` and returns its exit code and output. */
export async function exec(
  id: string,
  cmd: string[],
  { working_dir, timeout_ms }: { working_dir: string; timeout_ms: number }
): Promise<ExecResult> {
  const deadline = Date.now() + timeout_ms;
  const created = await docker_request(`${container_path(id)}/exec`, json<{ Id: string }>, {
    method: 'POST',
    body: { Cmd: cmd, WorkingDir: working_dir, AttachStdout: true, AttachStderr: true },
  });
  const frames = await docker_request(`/exec/${created.Id}/start`, bytes, {
    method: 'POST',
    body: { Detach: false, Tty: false },
    timeout_ms,
  });
  const { stdout, stderr } = demultiplex(frames);
  return {
    exit_code: await exec_exit_code(created.Id, deadline),
    stdout: decode(stdout),
    stderr: decode(stderr),
  };
}

/** A tar archive holding `files`, by path, as Docker's archive PUT takes it. */
export function tar(files: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  return new Bun.Archive(files).bytes();
}

/** The files of a tar archive Docker's archive GET made, by path. */
export async function untar(archive: Uint8Array): Promise<Map<string, File>> {
  return new Bun.Archive(archive).files();
}
