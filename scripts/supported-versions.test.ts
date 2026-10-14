// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test';

import { addRelease, renderSupportedVersions, supportedWindow } from './supported-versions';

const current = { latest: '0.1.734', supported: ['0.1.734', '0.1.733', '0.1.732'] };

describe('adding a stable release', () => {
  test('makes it the latest and drops the oldest supported version', () => {
    expect(addRelease(current, '0.1.735')).toEqual({
      latest: '0.1.735',
      supported: ['0.1.735', '0.1.734', '0.1.733'],
    });
  });

  test('leaves the policy unchanged when the release is already listed', () => {
    expect(addRelease(current, '0.1.734')).toEqual(current);
  });

  test('orders by version rather than by text', () => {
    expect(addRelease({ latest: '0.1.99', supported: ['0.1.99'] }, '0.1.100')).toEqual({
      latest: '0.1.100',
      supported: ['0.1.100', '0.1.99'],
    });
  });

  test('keeps a release older than the supported window out of it', () => {
    expect(addRelease(current, '0.1.731')).toEqual(current);
  });

  test('refuses versions that are not MAJOR.MINOR.PATCH', () => {
    expect(() => addRelease(current, 'v0.1.735')).toThrow(
      'v0.1.735 is not a release version like 0.1.732.'
    );
  });
});

describe('the window over every published release', () => {
  test('keeps a release the file on main has not caught up with', () => {
    const released = ['0.1.736', '0.1.735', '0.1.734', '0.1.733', '0.1.732'];
    expect(supportedWindow([...released, ...current.supported])).toEqual({
      latest: '0.1.736',
      supported: ['0.1.736', '0.1.735', '0.1.734'],
    });
  });

  test('refuses a tag that is not a release version', () => {
    expect(() => supportedWindow(['0.1.735', 'cli-v0.1.731'])).toThrow(
      'cli-v0.1.731 is not a release version like 0.1.732.'
    );
  });
});

describe('the repository policy', () => {
  test('is a policy the release workflow would have written', async () => {
    const file = Bun.file(`${import.meta.dir}/../packages/cli/supported-versions.json`);
    const text = await file.text();
    const policy = JSON.parse(text);
    expect(addRelease(policy, policy.latest)).toEqual(policy);
    expect(renderSupportedVersions(policy)).toBe(text);
  });
});
