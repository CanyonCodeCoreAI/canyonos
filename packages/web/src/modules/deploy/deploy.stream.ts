import type { DeploymentStatus } from '@canyonos/api/deploy';

import { authActions } from '@/modules/auth/auth.store';
import { webEnv } from '@/modules/core/lib/env';

// Mirrors the SSE frames the API emits (see deploy.stream.ts `to_frame`). On `stop_failed` the
// deployment is still live.
export type DeployStreamEvent =
  | { readonly type: 'phase'; readonly phase: DeploymentStatus; readonly seq: number }
  | { readonly type: 'succeeded'; readonly address: string | null; readonly seq: number }
  | { readonly type: 'failed'; readonly message: string | null; readonly seq: number }
  | { readonly type: 'stopped'; readonly message: string | null; readonly seq: number }
  | { readonly type: 'stop_failed'; readonly message: string | null; readonly seq: number };

interface SseFrame {
  readonly id?: string;
  readonly event?: string;
  readonly data: string;
}

function parseFrame(block: string): SseFrame {
  let id: string | undefined;
  let event: string | undefined;
  const dataLines: string[] = [];

  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line === '' || line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }

  return { id, event, data: dataLines.join('\n') };
}

function toEvent(frame: SseFrame): DeployStreamEvent | null {
  if (!frame.event) return null;

  let data: { phase?: DeploymentStatus; address?: string | null; message?: string | null } | null;
  try {
    data = frame.data ? JSON.parse(frame.data) : null;
  } catch {
    return null;
  }

  const parsedSeq = Number.parseInt(frame.id ?? '', 10);
  const seq = Number.isInteger(parsedSeq) ? parsedSeq : 0;

  if (frame.event === 'phase' && data?.phase) return { type: 'phase', phase: data.phase, seq };
  if (frame.event === 'succeeded')
    return { type: 'succeeded', address: data?.address ?? null, seq };
  if (frame.event === 'failed') return { type: 'failed', message: data?.message ?? null, seq };
  if (frame.event === 'stopped') return { type: 'stopped', message: data?.message ?? null, seq };
  if (frame.event === 'stop_failed')
    return { type: 'stop_failed', message: data?.message ?? null, seq };
  return null;
}

// Raised when the stream endpoint answers 404 (`deploy.not_found`): the deployment id does not
// resolve, which is terminal — the caller surfaces a not-found state rather than reconnecting.
export class DeployStreamNotFoundError extends Error {
  constructor() {
    super('deployment not found');
    this.name = 'DeployStreamNotFoundError';
  }
}

/**
 * Read one deployment's SSE progress stream to completion. Uses an authed `fetch` (not `EventSource`,
 * which cannot attach the Bearer token) and hands each parsed event to `onEvent`. Resolves when the
 * server closes the stream (a terminal event), throws `DeployStreamNotFoundError` on a 404, and throws
 * a plain error on a transport drop so the caller can resume from the last seq via `last-event-id`.
 */
export async function readDeployStream(
  project_id: string,
  deploy_id: string,
  lastEventId: string | undefined,
  onEvent: (event: DeployStreamEvent) => void,
  signal: AbortSignal
): Promise<void> {
  const token = authActions.getToken();
  const headers: Record<string, string> = { accept: 'text/event-stream' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (lastEventId) headers['last-event-id'] = lastEventId;

  const response = await fetch(
    `${webEnv.api.baseUrl}/projects/${project_id}/deploy/${deploy_id}/stream`,
    { headers, signal }
  );
  if (response.status === 404) throw new DeployStreamNotFoundError();
  if (!response.ok || !response.body) {
    throw new Error(`deploy stream failed (${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = toEvent(parseFrame(block));
      if (event) onEvent(event);
      boundary = buffer.indexOf('\n\n');
    }
  }
}
