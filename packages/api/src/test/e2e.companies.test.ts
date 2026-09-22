import { describe, expect, test } from 'bun:test';

import { api, setupE2ETests } from './e2e.setup';

setupE2ETests();

const authenticate = async (email: string) => {
  await api.auth.challenge.post({ email });
  const verify = await api.auth.verify.post({ email, code: '111111' });
  return verify.data?.token as string;
};

describe('companies CRUD', () => {
  test('create, get, and list a company', async () => {
    const token = await authenticate('companies-crud@canyonos.test');
    const auth = { authorization: `Bearer ${token}` };

    const created = await api.companies.post({ name: 'Initech' }, { headers: auth });
    expect(created.error).toBeNull();
    expect(created.data?.name).toBe('Initech');
    const id = created.data?.id as string;

    const fetched = await api.companies[id]!.get({ $headers: auth });
    expect(fetched.data?.id).toBe(id);
    expect(fetched.data?.name).toBe('Initech');

    const listed = await api.companies.get({ $headers: auth });
    expect(listed.data?.some((company) => company.id === id)).toBe(true);
  });

  test('listing companies without a token is rejected', async () => {
    const result = await api.companies.get();
    expect(result.error?.status as number).toBe(401);
  });

  test('creating a company with a blank name is rejected', async () => {
    const token = await authenticate('companies-blank@canyonos.test');
    const result = await api.companies.post(
      { name: '' },
      { headers: { authorization: `Bearer ${token}` } }
    );
    expect(result.error?.status as number).toBe(422);
  });

  test('fetching a company with a malformed id is rejected', async () => {
    const token = await authenticate('companies-badid@canyonos.test');
    const result = await api.companies['not-a-uuid']!.get({
      $headers: { authorization: `Bearer ${token}` },
    });
    expect(result.error?.status as number).toBe(422);
  });

  test('fetching a missing company returns 404', async () => {
    const token = await authenticate('companies-missing@canyonos.test');
    const result = await api.companies['00000000-0000-0000-0000-000000000000']!.get({
      $headers: { authorization: `Bearer ${token}` },
    });
    expect(result.error?.status as number).toBe(404);
  });
});
