// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { db, sql } from '@api/db/client';
import { users } from '@api/db/schema';
import type { AuthToken } from '@api/modules/auth/types';

import { api, setupE2ETests } from './e2e.setup';
import { bearer, create_test_project, create_test_user, TEST_PASSWORD } from './project-test.utils';

setupE2ETests();

const CLOSED = {
  status: 403,
  error: 'auth.registration_closed',
  message: 'Registration is closed; sign in with an existing account',
};
const INVALID_CREDENTIALS = {
  status: 401,
  error: 'auth.invalid_credentials',
  message: 'Invalid email or password',
};

const register = (email: string, password = TEST_PASSWORD, password_confirmation = password) =>
  api.auth.register.post({ email, password, password_confirmation });

const count_users = async (): Promise<number> =>
  (await db.select({ id: users.id }).from(users)).length;

const failure = (res: { error: { status: unknown; value: unknown } | null }) => {
  const value = res.error?.value as { error?: string; message?: string } | undefined;
  return { status: res.error?.status, error: value?.error, message: value?.message };
};

async function wait_for_lock_waiters(expected: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const [row] = await sql<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting FROM pg_locks
      WHERE relation = 'users'::regclass AND NOT granted
    `;
    if (row!.waiting >= expected) return;
    await Bun.sleep(25);
  }
  throw new Error(`Fewer than ${expected} registrations reached the users lock`);
}

let first: AuthToken;

describe('password accounts', () => {
  // Other e2e files share this process and database, so the install starts over without accounts.
  beforeAll(async () => {
    await db.delete(users);
  });

  test('status is false before anyone registers', async () => {
    const status = await api.auth.status.get();
    expect(status.error).toBeNull();
    expect(status.data).toEqual({ mode: 'password', has_users: false });

    const login = await api.auth.login.post({
      email: 'first@canyonos.test',
      password: TEST_PASSWORD,
    });
    expect(failure(login)).toEqual(INVALID_CREDENTIALS);
  });

  test('registration rejects a mismatched confirmation and a short password', async () => {
    const mismatched = await register('mismatch@canyonos.test', TEST_PASSWORD, 'something-else');
    expect(mismatched.error?.status as number).toBe(422);

    const short = await register('short@canyonos.test', 'short', 'short');
    expect(short.error?.status as number).toBe(422);

    expect(await count_users()).toBe(0);
  });

  test('two concurrent first registrations yield one row, one 201 and one 403', async () => {
    let pending: Promise<Awaited<ReturnType<typeof register>>[]> | undefined;
    // Holding the users lock parks both inserts until each has passed the empty-table check.
    await sql.begin(async (tx) => {
      await tx`LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`;
      pending = Promise.all([register('First@Canyonos.Test'), register('Rival@Canyonos.Test')]);
      await wait_for_lock_waiters(2);
    });
    const results = await pending!;

    expect(results.map((res) => res.status).sort((a, b) => a - b)).toEqual([201, 403]);
    const loser = results.find((res) => res.status === 403)!;
    expect(failure(loser)).toEqual(CLOSED);
    expect(await count_users()).toBe(1);
    first = results.find((res) => res.status === 201)!.data!;
  });

  test('the first registration returns a session and flips status', async () => {
    expect(['first@canyonos.test', 'rival@canyonos.test']).toContain(first.user.email);
    expect(first.token).toBeString();
    expect(first.user).not.toHaveProperty('password_hash');

    expect((await api.auth.status.get()).data).toEqual({ mode: 'password', has_users: true });

    const profile = await api.auth.profile.get({ $headers: bearer(first.token) });
    expect(profile.error).toBeNull();
    expect(profile.data).toEqual(first.user);

    const [row] = await db.select().from(users).where(eq(users.email, first.user.email));
    expect(row?.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(row?.password_hash).not.toBe(TEST_PASSWORD);
  });

  test('registration is closed once a user exists', async () => {
    expect(failure(await register('late@canyonos.test'))).toEqual(CLOSED);
    expect(failure(await register(first.user.email.toUpperCase()))).toEqual(CLOSED);
    expect(await count_users()).toBe(1);
  });

  test('login succeeds with the right password and fails identically otherwise', async () => {
    const ok = await api.auth.login.post({
      email: ` ${first.user.email.toUpperCase()} `,
      password: TEST_PASSWORD,
    });
    expect(ok.error).toBeNull();
    expect(ok.status).toBe(200);
    expect(ok.data?.token).toBeString();
    expect(ok.data?.user).toEqual(first.user);

    const wrong = await api.auth.login.post({
      email: first.user.email,
      password: 'wrong-password-1',
    });
    const unknown = await api.auth.login.post({
      email: 'nobody@canyonos.test',
      password: TEST_PASSWORD,
    });
    expect(failure(wrong)).toEqual(INVALID_CREDENTIALS);
    expect(failure(unknown)).toEqual(INVALID_CREDENTIALS);
  });

  test('a token stops working on every route once its user is deleted', async () => {
    await create_test_user('deleted@canyonos.test');
    const login = await api.auth.login.post({
      email: 'deleted@canyonos.test',
      password: TEST_PASSWORD,
    });
    expect(login.error).toBeNull();
    const headers = bearer(login.data!.token);
    expect((await api.projects.get({ $headers: headers })).error).toBeNull();

    await db.delete(users).where(eq(users.email, 'deleted@canyonos.test'));

    expect(failure(await api.projects.get({ $headers: headers }))).toMatchObject({
      status: 401,
      error: 'auth.invalid_token',
    });
  });

  test('profile rejects a missing and a forged token', async () => {
    expect(failure(await api.auth.profile.get())).toMatchObject({
      status: 401,
      error: 'auth.missing_token',
    });
    expect(failure(await api.auth.profile.get({ $headers: bearer('x.y.z') }))).toMatchObject({
      status: 401,
      error: 'auth.invalid_token',
    });
  });

  test('a second user sees the same projects as the first', async () => {
    await create_test_user('second@canyonos.test');
    const login = await api.auth.login.post({
      email: 'second@canyonos.test',
      password: TEST_PASSWORD,
    });
    expect(login.error).toBeNull();
    const second = bearer(login.data!.token);
    const { project_id } = await create_test_project(first.token, { name: 'Shared Install' });

    const listed = await api.projects.get({ $headers: second });
    expect(listed.error).toBeNull();
    expect(listed.data!.map(({ id }) => id)).toContain(project_id);

    const detail = await api.projects[project_id]!.get({ $headers: second });
    expect(detail.error).toBeNull();
    expect(detail.data?.id).toBe(project_id);
  });
});
