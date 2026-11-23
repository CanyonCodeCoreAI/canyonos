// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { edenTreaty } from '@elysiajs/eden';

import type { CanyonosApi } from '@api/app';
import { config } from '@core/env';

const READY_TIMEOUT_MS = 30_000;
const POLL_MS = 200;

/** An Eden client of the API at `url`, the suite's own unless given. */
export const createApi = (
  url: string = config.app.apiUrl
): ReturnType<typeof edenTreaty<CanyonosApi>> => edenTreaty<CanyonosApi>(url);

/** Resolves once `<url><path>` answers 200, polling until `timeout_ms` passes. */
export async function until_answers(
  url: string,
  path: '/v1/healthz' | '/v1/readyz',
  timeout_ms = READY_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeout_ms;
  while (Date.now() < deadline) {
    const ok = await fetch(`${url}${path}`)
      .then((response) => response.ok)
      .catch(() => false);
    if (ok) return;
    await Bun.sleep(POLL_MS);
  }
  throw new Error(`${url}${path} did not answer 200 within ${timeout_ms / 1000} s`);
}

/** Resolves once the API at `url` is ready: its database migrated and answering. */
export const until_ready = (url: string) => until_answers(url, '/v1/readyz');

export interface RawAnswer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}

/** Whether `answer` holds its head and the Content-Length bytes of body it names. */
function is_whole(answer: string): boolean {
  const head_end = answer.indexOf('\r\n\r\n');
  if (head_end === -1) return false;
  const length = /\r\ncontent-length:\s*(\d+)/i.exec(answer.slice(0, head_end))?.[1];
  return length !== undefined && Buffer.byteLength(answer.slice(head_end + 4)) >= Number(length);
}

/** The answer to `<method> <target>` with `headers`, sent as is over a socket to the API on
 * `port`, the suite's own unless given, which no URL parser resolves first. */
export async function raw_request(
  method: string,
  target: string,
  headers: Record<string, string> = {},
  port: number = config.app.port
): Promise<RawAnswer> {
  const { promise, resolve } = Promise.withResolvers<string>();
  let received = '';
  await Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: {
      open(socket) {
        const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`);
        socket.write(
          `${method} ${target} HTTP/1.1\r\nHost: localhost\r\n${lines.join('')}Connection: close\r\n\r\n`
        );
      },
      // Bun leaves the connection open after an answer an async guard gave, `close` or not.
      data(socket, data) {
        received += data.toString();
        if (!is_whole(received)) return;
        socket.end();
        resolve(received);
      },
      close: () => resolve(received),
      error: () => resolve(received),
    },
  });
  const answer = await promise;
  const [head = '', body = ''] = answer.split('\r\n\r\n');
  const [status_line = '', ...header_lines] = head.split('\r\n');
  const answer_headers = new Headers(
    header_lines.map((line): [string, string] => {
      const colon = line.indexOf(':');
      return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
    })
  );
  return { status: Number(status_line.split(' ')[1]), headers: answer_headers, body };
}
