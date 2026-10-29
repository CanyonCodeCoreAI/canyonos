// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RedisClient } from 'bun';
import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { config } from '@core/env';
import { notFound } from '@core/errors';

import { redis_url, with_redis, with_redis_at } from './canyonos.redis';
import { forget_registry } from './canyonos.registry';

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error
  );

const connect = spyOn(RedisClient.prototype, 'connect');
const close = spyOn(RedisClient.prototype, 'close');

describe('with_redis_at', () => {
  beforeEach(() => {
    connect.mockReset().mockResolvedValue(undefined);
    close.mockReset().mockReturnValue(undefined);
  });

  afterAll(() => {
    connect.mockRestore();
    close.mockRestore();
  });

  test('a failed connection is reported as the controller being unreachable', async () => {
    const refused = new Error('ECONNREFUSED');
    connect.mockRejectedValue(refused);

    expect(await rejection(with_redis_at(6379, async () => 'unreached'))).toMatchObject({
      status: 502,
      code: 'canyonos.controller_unreachable',
      cause: refused,
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('an error thrown by the operation propagates unchanged', async () => {
    const failure = new TypeError('versions.flatMap is not a function');

    expect(
      await rejection(
        with_redis_at(6379, async () => {
          throw failure;
        })
      )
    ).toBe(failure);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('an AppError thrown by the operation propagates unchanged', async () => {
    const failure = notFound('prompts.prompt_not_found', 'missing');

    expect(
      await rejection(
        with_redis_at(6379, async () => {
          throw failure;
        })
      )
    ).toBe(failure);
  });

  test('the operation result is returned and the connection closed', async () => {
    expect(await with_redis_at(6379, async () => 42)).toBe(42);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('redis_url', () => {
  test('a Redis without a password, as on Docker, gets no credentials', () => {
    expect(redis_url({ host: 'host.docker.internal', port: 6379 })).toBe(
      'redis://host.docker.internal:6379'
    );
  });

  test('signs in with the password, escaped', () => {
    expect(redis_url({ host: 'canyonos-redis.acme.svc', port: 6379, password: 'p@ss/word' })).toBe(
      'redis://:p%40ss%2Fword@canyonos-redis.acme.svc:6379'
    );
  });

  test('uses TLS and a username for an external Redis', () => {
    expect(
      redis_url({ host: 'r.example.com', port: 6380, tls: true, username: 'app', password: 'x' })
    ).toBe('rediss://app:x@r.example.com:6380');
  });
});

describe('with_redis on Kubernetes', () => {
  test('a project the operator no longer lists is not running, with no fallback', async () => {
    connect.mockReset().mockResolvedValue(undefined);
    const dir = mkdtempSync(join(tmpdir(), 'registry-'));
    const path = join(dir, 'projects.json');
    writeFileSync(path, JSON.stringify({ projects: [] }));
    const configured = config.canyonos.projectsFile;
    config.canyonos.projectsFile = path;
    forget_registry();
    try {
      const gone = '11111111-1111-4111-8111-111111111111';
      expect(await rejection(with_redis(gone, async () => 'unreached'))).toMatchObject({
        status: 404,
        code: 'canyonos.project_not_running',
      });
      expect(connect).not.toHaveBeenCalled();
    } finally {
      config.canyonos.projectsFile = configured;
      forget_registry();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
