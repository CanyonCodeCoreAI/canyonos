import { RedisClient } from 'bun';
import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { notFound } from '@core/errors';

import { with_redis } from './canyonos.redis';

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error
  );

const connect = spyOn(RedisClient.prototype, 'connect');
const close = spyOn(RedisClient.prototype, 'close');

describe('with_redis', () => {
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

    expect(await rejection(with_redis(async () => 'unreached'))).toMatchObject({
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
        with_redis(async () => {
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
        with_redis(async () => {
          throw failure;
        })
      )
    ).toBe(failure);
  });

  test('the operation result is returned and the connection closed', async () => {
    expect(await with_redis(async () => 42)).toBe(42);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
