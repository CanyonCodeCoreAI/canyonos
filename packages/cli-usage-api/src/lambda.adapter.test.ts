// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { createApp } from './app';
import { toRequest, toResult } from './lambda.adapter';
import { usageEvents } from './test.fixtures';
import type { UsageRepository } from './usage.repository';

const apiGatewayEvent = (
  overrides: Partial<APIGatewayProxyEventV2> = {}
): APIGatewayProxyEventV2 => ({
  version: '2.0',
  routeKey: '$default',
  rawPath: '/usage/events',
  rawQueryString: '',
  headers: { host: 'usage.canyonos.example', 'content-type': 'application/json' },
  isBase64Encoded: false,
  requestContext: {
    accountId: '123456789012',
    apiId: 'api',
    domainName: 'usage.canyonos.example',
    domainPrefix: 'usage',
    http: {
      method: 'POST',
      path: '/usage/events',
      protocol: 'HTTP/1.1',
      sourceIp: '203.0.113.7',
      userAgent: 'canyonos',
    },
    requestId: 'request',
    routeKey: '$default',
    stage: '$default',
    time: '08/Oct/2026:12:00:00 +0000',
    timeEpoch: 0,
  },
  ...overrides,
});

describe('toRequest', () => {
  test('builds the URL, method, headers and cookies of the request', () => {
    const request = toRequest(
      apiGatewayEvent({
        rawQueryString: 'a=1&b=2',
        headers: { host: 'usage.canyonos.example', 'x-trace': 'abc' },
        cookies: ['session=1', 'theme=dark'],
      })
    );

    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://usage.canyonos.example/usage/events?a=1&b=2');
    expect(request.headers.get('x-trace')).toBe('abc');
    expect(request.headers.get('cookie')).toBe('session=1; theme=dark');
  });

  test('falls back to the domain name when the host header is missing', () => {
    const request = toRequest(apiGatewayEvent({ headers: {} }));
    expect(new URL(request.url).host).toBe('usage.canyonos.example');
  });

  test('passes a plain body through', async () => {
    const request = toRequest(apiGatewayEvent({ body: '{"events":[]}' }));
    expect(await request.text()).toBe('{"events":[]}');
  });

  test('decodes a base64 body', async () => {
    const body = Buffer.from('{"events":["é"]}').toString('base64');
    const request = toRequest(apiGatewayEvent({ body, isBase64Encoded: true }));
    expect(await request.text()).toBe('{"events":["é"]}');
  });

  test('drops a body on GET', () => {
    const event = apiGatewayEvent({ body: 'ignored' });
    event.requestContext.http.method = 'GET';
    expect(toRequest(event).body).toBeNull();
  });
});

describe('toResult', () => {
  test('keeps the status, headers and a JSON body as text', async () => {
    const result = await toResult(
      Response.json({ stored: 1 }, { status: 201, headers: { 'x-request-id': 'r1' } })
    );

    expect(result).toEqual({
      statusCode: 201,
      headers: { 'content-type': 'application/json;charset=utf-8', 'x-request-id': 'r1' },
      body: '{"stored":1}',
      isBase64Encoded: false,
    });
  });

  test('moves every Set-Cookie header into cookies', async () => {
    const headers = new Headers({ 'content-type': 'text/plain' });
    headers.append('set-cookie', 'a=1; Path=/');
    headers.append('set-cookie', 'b=2; HttpOnly');

    const result = await toResult(new Response('ok', { headers }));

    expect(result.cookies).toEqual(['a=1; Path=/', 'b=2; HttpOnly']);
    expect(result.headers).toEqual({ 'content-type': 'text/plain' });
  });

  test('base64-encodes a binary body', async () => {
    const bytes = new Uint8Array([0, 255, 16, 32]);
    const result = await toResult(
      new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })
    );

    expect(result.isBase64Encoded).toBe(true);
    expect(Buffer.from(result.body ?? '', 'base64')).toEqual(Buffer.from(bytes));
  });

  test('returns an empty body as text', async () => {
    const result = await toResult(new Response(null, { status: 204 }));
    expect(result).toMatchObject({ statusCode: 204, body: '', isBase64Encoded: false });
  });
});

describe('the Lambda round trip', () => {
  const repository: UsageRepository = {
    storeEvents: async (events) => ({ stored: events.length, duplicates: 0 }),
  };
  const app = createApp({ repository });
  const invoke = async (event: APIGatewayProxyEventV2) =>
    toResult(await app.handle(toRequest(event)));

  test('stores a base64-encoded batch', async () => {
    const body = Buffer.from(JSON.stringify({ events: usageEvents(2) })).toString('base64');
    const result = await invoke(apiGatewayEvent({ body, isBase64Encoded: true }));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body ?? '')).toEqual({ stored: 2, duplicates: 0 });
  });

  test('rejects an invalid batch', async () => {
    const result = await invoke(apiGatewayEvent({ body: '{"events":[{}]}' }));
    expect(result.statusCode).toBe(422);
  });
});
