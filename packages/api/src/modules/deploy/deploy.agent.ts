// Outbound HTTP client for a project's deployed agent (the instance a successful deploy provisions).

import { AppError, badGateway } from '@core/errors';

const AGENT_PORT = 8080;
const AGENT_ENTRY = 'main';
const REQUEST_TIMEOUT_MS = 15_000;

const DEFAULT_POLL_INTERVAL_MS = 500;
// Some deployed workflows run up to a few minutes. Bun's own idleTimeout (see app.ts) cannot
// exceed 255s, so this stays a little under that ceiling to leave room for a clean timeout
// response instead of racing the socket getting killed out from under it.
export const DEFAULT_POLL_TIMEOUT_MS = 250_000;

let poll_interval_ms = DEFAULT_POLL_INTERVAL_MS;
let poll_timeout_ms = DEFAULT_POLL_TIMEOUT_MS;

export interface AgentResponse {
  readonly status: number;
  readonly text: string;
}

export type AgentCaller = (
  url: string,
  init?: { method?: string; body?: string }
) => Promise<AgentResponse>;

function agent_base_url(address: string): string {
  const host = address.replace(/^[a-z]+:\/\//i, '').replace(/[:/].*$/, '');
  return `http://${host}:${AGENT_PORT}`;
}

const default_caller: AgentCaller = async (url, init) => {
  const response = await fetch(url, {
    method: init?.method ?? 'GET',
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    body: init?.body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: response.status, text: await response.text() };
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let caller: AgentCaller = default_caller;

/** @internal Test seam — swap the outbound agent transport. See deploy.agent.testkit. */
export function __set_agent_caller(next: AgentCaller | null): void {
  caller = next ?? default_caller;
}

/** @internal Test seam — override the status poll cadence. See deploy.agent.testkit. */
export function __set_agent_poll(next: { interval_ms: number; timeout_ms: number } | null): void {
  poll_interval_ms = next?.interval_ms ?? DEFAULT_POLL_INTERVAL_MS;
  poll_timeout_ms = next?.timeout_ms ?? DEFAULT_POLL_TIMEOUT_MS;
}

function parse_request_id(text: string): string | undefined {
  try {
    const request_id = (JSON.parse(text) as { request_id?: unknown }).request_id;
    return typeof request_id === 'string' ? request_id : undefined;
  } catch {
    return undefined;
  }
}

function is_2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

// The deployed agent runs the test asynchronously: POST /main accepts the job and returns a
// request_id, and the result only appears once GET /status/<id> reports done. Non-2xx responses from
// either leg pass straight back to the caller so the UI renders the upstream failure verbatim.
// `body` is a plain JSON payload, not DeployTestBody -- each deployed workflow's own main() has its
// own kwarg names (e.g. text2sql's `question`/`n_candidates` vs. the generic tester's `query`), so
// the transport must not hardcode the UI's body shape.
export async function call_deployed_agent(
  address: string,
  body: Record<string, unknown>,
  opts?: { pollTimeoutMs?: number }
): Promise<AgentResponse> {
  const base = agent_base_url(address);
  const submit_url = `${base}/${AGENT_ENTRY}`;
  try {
    const submitted = await caller(submit_url, { method: 'POST', body: JSON.stringify(body) });
    if (!is_2xx(submitted.status)) return submitted;

    const request_id = parse_request_id(submitted.text);
    if (request_id === undefined) {
      throw badGateway(
        'deploy.test_unexpected',
        'The deployed endpoint did not return a request id'
      );
    }

    // Per-call override, not the shared poll_timeout_ms -- concurrent callers with different
    // deadlines must not race each other via that global.
    const deadline = Date.now() + (opts?.pollTimeoutMs ?? poll_timeout_ms);
    for (;;) {
      const polled = await caller(`${base}/status/${request_id}`);
      if (!is_2xx(polled.status)) return polled;

      const parsed = JSON.parse(polled.text) as {
        status?: string;
        result?: unknown;
        error?: unknown;
      };
      if (parsed.status === 'done') {
        return { status: polled.status, text: JSON.stringify(parsed.result ?? parsed) };
      }
      if (parsed.status === 'error') {
        // The deployed workflow already failed and reported so -- surface that now instead of
        // polling to the timeout for a `done` that will never arrive.
        throw badGateway(
          'deploy.test_failed',
          typeof parsed.error === 'string'
            ? parsed.error
            : 'The deployed workflow reported an error'
        );
      }
      if (Date.now() >= deadline) {
        throw badGateway(
          'deploy.test_timeout',
          'The deployed endpoint did not finish the test in time'
        );
      }
      await delay(poll_interval_ms);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw badGateway(
      'deploy.test_unreachable',
      `Could not reach the deployed endpoint at ${submit_url}`,
      { cause: error }
    );
  }
}
