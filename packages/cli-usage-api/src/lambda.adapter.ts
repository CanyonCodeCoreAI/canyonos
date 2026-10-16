// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Converts between API Gateway HTTP API events (payload format 2.0) and the Fetch API requests
 * and responses the app handles, so the Lambda serves the same app as the local server.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

const METHODS_WITHOUT_BODY = new Set(['GET', 'HEAD']);
const TEXTUAL_CONTENT_TYPE =
  /^(?:text\/|application\/(?:json|xml|javascript|x-www-form-urlencoded)|[^;]+\+(?:json|xml))/i;

/** Build the request the app receives from an API Gateway event. */
export function toRequest(event: APIGatewayProxyEventV2): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) headers.set(name, value);
  }
  if (event.cookies?.length) headers.set('cookie', event.cookies.join('; '));

  const host = event.headers?.host ?? event.requestContext.domainName;
  const query = event.rawQueryString ? `?${event.rawQueryString}` : '';
  const method = event.requestContext.http.method.toUpperCase();
  const carriesBody = event.body !== undefined && !METHODS_WITHOUT_BODY.has(method);
  const body = carriesBody
    ? Buffer.from(event.body ?? '', event.isBase64Encoded ? 'base64' : 'utf8')
    : undefined;

  return new Request(`https://${host}${event.rawPath}${query}`, { method, headers, body });
}

/**
 * Build the API Gateway result from the app's response: `Set-Cookie` headers go to `cookies`,
 * and a body that is not text goes base64-encoded.
 */
export async function toResult(response: Response): Promise<APIGatewayProxyStructuredResultV2> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') headers[name] = value;
  });
  const cookies = response.headers.getSetCookie();
  const bytes = Buffer.from(await response.arrayBuffer());
  const textual =
    bytes.byteLength === 0 || TEXTUAL_CONTENT_TYPE.test(response.headers.get('content-type') ?? '');

  return {
    statusCode: response.status,
    headers,
    ...(cookies.length > 0 ? { cookies } : {}),
    body: bytes.toString(textual ? 'utf8' : 'base64'),
    isBase64Encoded: !textual,
  };
}
