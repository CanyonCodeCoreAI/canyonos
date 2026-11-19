// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

// Writes the API's OpenAPI spec to packages/api/openapi.json, which the SDK is generated from: it
// asks the app for /docs/json without connecting to the database or migrating it. It listens on
// a free loopback port rather than calling `app.handle`, which crashes Bun 1.3.14 on this app.

import { app } from './app';

const OUTPUT = new URL('../openapi.json', import.meta.url).pathname;

const server = app.listen({ hostname: '127.0.0.1', port: 0 }).server;
if (!server) throw new Error('The app did not start listening');
const response = await fetch(`http://127.0.0.1:${server.port}/docs/json`);
if (!response.ok) {
  throw new Error(`The app answered ${response.status} for its spec: ${await response.text()}`);
}
await Bun.write(OUTPUT, `${JSON.stringify(await response.json(), null, 2)}\n`);
console.log(`Wrote ${OUTPUT}`);
process.exit(0);
