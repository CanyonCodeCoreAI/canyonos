// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { join } from 'node:path';

import { config } from './env';
import { AppError, badGateway } from './errors';

// The few Kubernetes API calls /v1/workflow-groups makes on Kubernetes, as the API pod's service account, with
// plain fetch, as @core/docker reaches the Docker Engine: no client library for a handful of
// calls. The service account token is read again at most once a minute, since Kubernetes
// rotates the projected file; CANYONOS_K8S_API points the client at another server instead,
// such as `kubectl proxy` or a test's stand-in, called without a token.

export const API_GROUP = 'canyonos.canyoncode.ai';
export const API_VERSION = 'v1alpha1';
/** Where the CanyonOS resources (CanyonBuild, CanyonProject, CanyonAgent) are served. */
export const CANYONOS_API = `/apis/${API_GROUP}/${API_VERSION}`;
export const MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by';
/** The field manager, and the managed-by label, of what the CLI's deploys write. */
export const FIELD_MANAGER = 'canyonos-cli';

const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_REFRESH_MS = 60_000;
const ERROR_TEXT_CHARACTERS = 300;

export interface ObjectMeta {
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  deletionTimestamp?: string;
}

export interface KubernetesObject<
  Spec = Record<string, unknown>,
  Status = Record<string, unknown>,
> {
  metadata: ObjectMeta;
  spec?: Spec;
  status?: Status;
}

interface ObjectList<T> {
  items?: T[];
}

/** The object name Kubernetes takes for `name`: lowercase, with anything but letters, digits and
 * hyphens turned into hyphens, at most 63 characters (canyonos_core/kubernetes/api.py
 * `resource_name`, which the CLI and the operator share). */
export function resource_name(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleaned) throw new Error(`${JSON.stringify(name)} has no letters or digits to use`);
  return cleaned.slice(0, 63).replace(/-+$/, '');
}

/** `key=value,...` for a labelSelector query parameter. */
export function label_selector(labels: Record<string, string>): string {
  return encodeURIComponent(
    Object.entries(labels)
      .map(([key, value]) => `${key}=${value}`)
      .join(',')
  );
}

interface Credentials {
  token: string | null;
  ca: string | null;
  read_at: number;
}

let credentials: Credentials | null = null;

async function read_optional(path: string): Promise<string | null> {
  const file = Bun.file(path);
  return (await file.exists()) ? (await file.text()).trim() : null;
}

/** The service account token and the cluster CA, read again once a minute. */
async function service_account(): Promise<Credentials> {
  if (credentials && Date.now() - credentials.read_at < TOKEN_REFRESH_MS) return credentials;
  const dir = config.kubernetes.serviceAccountDir;
  const [token, ca] = await Promise.all([
    read_optional(join(dir, 'token')),
    read_optional(join(dir, 'ca.crt')),
  ]);
  credentials = { token, ca, read_at: Date.now() };
  return credentials;
}

function failure(method: string, path: string, reason: string, status?: number): AppError {
  return badGateway('kubernetes.error', `Kubernetes API ${method} ${path} failed${reason}`, {
    meta: status === undefined ? undefined : { status },
  });
}

function base_url(method: string, path: string): string {
  const { apiUrl, serviceHost, servicePort } = config.kubernetes;
  if (apiUrl) return apiUrl.replace(/\/+$/, '');
  if (!serviceHost) {
    throw failure(
      method,
      path,
      ': not inside a Kubernetes pod (KUBERNETES_SERVICE_HOST is unset); set CANYONOS_K8S_API ' +
        'to reach the API server another way'
    );
  }
  const host = serviceHost.includes(':') ? `[${serviceHost}]` : serviceHost;
  return `https://${host}:${servicePort}`;
}

interface CallOptions {
  body?: unknown;
  content_type?: string;
  accept?: string;
  /** Bounds the whole answer; null for a stream that stays open, such as a followed log. */
  timeout_ms?: number | null;
  signal?: AbortSignal;
}

/** Sends one API request; answers its response once it is a 2xx, else throws `kubernetes.error`
 * (502) with the status and the start of the answer. */
async function call(
  method: string,
  path: string,
  {
    body,
    content_type = 'application/json',
    accept = 'application/json',
    timeout_ms = REQUEST_TIMEOUT_MS,
    signal,
  }: CallOptions = {}
): Promise<Response> {
  const url = `${base_url(method, path)}${path}`;
  const headers: Record<string, string> = { accept };
  let tls: { ca: string } | undefined;
  if (!config.kubernetes.apiUrl) {
    const { token, ca } = await service_account();
    if (token) headers.authorization = `Bearer ${token}`;
    if (ca) tls = { ca };
  }
  if (body !== undefined) headers['content-type'] = content_type;
  const signals = [
    ...(timeout_ms === null ? [] : [AbortSignal.timeout(timeout_ms)]),
    ...(signal ? [signal] : []),
  ];
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
      ...(tls ? { tls } : {}),
    });
  } catch (error) {
    throw failure(method, path, `: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status >= 400) {
    const text = await response.text().catch(() => '');
    throw failure(
      method,
      path,
      ` with ${response.status}: ${text.slice(0, ERROR_TEXT_CHARACTERS)}`,
      response.status
    );
  }
  return response;
}

/** Calls the API with an optional JSON body; answers the decoded JSON, `{}` for none. */
export async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  options: CallOptions = {}
): Promise<T> {
  const response = await call(method, path, options);
  const text = await response.text();
  return (text ? JSON.parse(text) : {}) as T;
}

export const get = <T>(path: string) => request<T>('GET', path);

/** The objects at collection `path` that carry every one of `labels`. */
export async function list<T>(path: string, labels?: Record<string, string>): Promise<T[]> {
  const query = labels ? `?labelSelector=${label_selector(labels)}` : '';
  return (await request<ObjectList<T>>('GET', `${path}${query}`)).items ?? [];
}

/** Server-side applies `object` at `path`, owning only the fields it sets. */
export function apply<T>(path: string, object: unknown): Promise<T> {
  return request<T>('PATCH', `${path}?fieldManager=${FIELD_MANAGER}&force=true`, {
    body: object,
    content_type: 'application/apply-patch+yaml',
  });
}

export function merge_patch<T>(path: string, patch: unknown): Promise<T> {
  return request<T>('PATCH', path, {
    body: patch,
    content_type: 'application/merge-patch+json',
  });
}

export function remove(path: string): Promise<unknown> {
  return request('DELETE', path);
}

/** Deletes every object at collection `path` that carries all of `labels`. */
export function remove_all(path: string, labels: Record<string, string>): Promise<unknown> {
  return request('DELETE', `${path}?labelSelector=${label_selector(labels)}`);
}

export interface PodLogOptions {
  container?: string;
  /** How many lines from the end, or `all`. */
  tail: string;
}

function log_path(namespace: string, pod: string, { container, tail }: PodLogOptions): string {
  const query = new URLSearchParams({
    ...(container ? { container } : {}),
    ...(tail === 'all' ? {} : { tailLines: tail }),
  });
  const encoded = query.toString();
  return `/api/v1/namespaces/${namespace}/pods/${pod}/log${encoded ? `?${encoded}` : ''}`;
}

/** The pod's log so far, as text. */
export async function pod_log(
  namespace: string,
  pod: string,
  options: PodLogOptions
): Promise<string> {
  const response = await call('GET', log_path(namespace, pod, options), { accept: '*/*' });
  return response.text();
}

/** The pod's log as a stream that keeps the new lines coming until the container stops or
 * `signal` aborts; no timeout. */
export async function follow_pod_log(
  namespace: string,
  pod: string,
  options: PodLogOptions,
  signal: AbortSignal
): Promise<ReadableStream<Uint8Array>> {
  const path = `${log_path(namespace, pod, options)}${options.tail === 'all' && !options.container ? '?' : '&'}follow=true`;
  const response = await call('GET', path, { accept: '*/*', timeout_ms: null, signal });
  return response.body ?? new ReadableStream({ start: (controller) => controller.close() });
}

/** Whether `error` is the API's 404 for an object that is not there. */
export function is_not_found(error: unknown): boolean {
  return (
    error instanceof AppError && error.code === 'kubernetes.error' && error.meta?.status === 404
  );
}
