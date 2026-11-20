// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Elysia } from 'elysia';
import type { BunRequest } from 'bun';
import type { Context } from 'elysia';

import { badRequest, early_refusal } from './errors';

// Bun resolves `.` and `..` in request.url, as the WHATWG URL parser does, but its router
// matches the raw path of the request line and hands each `:param` over decoded: raw
// `/v1/workflows/..` reaches `/v1/workflows/:workflow_id` with workflow_id `..`, while
// request.url says `/v1`. So the key guards, which read request.url, would judge another path
// than the route that answers. A dot segment is refused before either looks at it.

const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;
// The separators the URL parser splits a path on; it takes a backslash for a slash.
const SEGMENT_SEPARATOR = /[/\\]/;

const has_dot_segment = (part: string) =>
  part.split(SEGMENT_SEPARATOR).some((segment) => DOT_SEGMENT.test(segment));

/** Whether the request's path holds a `.` or `..` segment, raw or percent-encoded, as the router
 * sees it: in a matched route's params, or in request.url where Bun left one. */
export function has_dot_segments(request: Request): boolean {
  const { params } = request as Partial<BunRequest>;
  const url = request.url;
  const start = url.indexOf('/', url.indexOf('//') + 2);
  const query = url.indexOf('?', start);
  const path = start === -1 ? '' : url.slice(start, query === -1 ? undefined : query);
  return has_dot_segment(path) || Object.values(params ?? {}).some(has_dot_segment);
}

/** Refuses, 400 `bad_request`, a request whose path holds a `.` or `..` segment; mount it before
 * every guard that reads the path. */
export const dotSegmentGuard = new Elysia({ name: 'dot-segments' }).onRequest(
  ({ request, set }: Pick<Context, 'request' | 'set'>) => {
    if (!has_dot_segments(request)) return;
    return early_refusal(
      set,
      badRequest('bad_request', 'Path segments `.` and `..` are not allowed')
    );
  }
);
