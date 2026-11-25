// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test';

import { config } from '@core/env';

import { setupE2ETests } from './e2e.setup';

setupE2ETests();

describe('docs', () => {
  test('/docs hands Scalar a configuration it can read, naming the spec it then loads', async () => {
    const page = `${config.app.apiUrl}/docs`;
    const response = await fetch(page);
    expect(response.status).toBe(200);
    const html = await response.text();
    // The attribute ends where it should: nothing in it ends it early.
    const attribute = /data-configuration='([^']*)'\s*>\s*<\/script>/.exec(html)?.[1];
    expect(attribute).toBeDefined();
    const configuration = JSON.parse(attribute!.replaceAll('&#39;', "'").replaceAll('&amp;', '&'));
    // The spec, with the apostrophes that cut the plugin's own page short, comes from its URL.
    const spec = await (await fetch(new URL(configuration.url, page))).json();
    expect(spec.info.title).toBe('CanyonOS API');
    expect(spec.info.description).toContain("workflow group's own key");
  });
});
