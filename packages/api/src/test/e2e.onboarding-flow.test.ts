import { describe, expect, test } from 'bun:test';

import { UserStatusEnum } from '@api/modules/auth/types';

import { api, setupE2ETests } from './e2e.setup';

setupE2ETests();

const authenticate = async (email: string) => {
  await api.auth.challenge.post({ email });
  const verify = await api.auth.verify.post({ email, code: '111111' });
  return verify.data?.token as string;
};

describe('onboarding flow', () => {
  test('create endpoint provisions a company, links the user, and activates them', async () => {
    const token = await authenticate('onboard-create@cc-forge.test');
    const auth = { authorization: `Bearer ${token}` };

    const result = await api.onboarding.create.post(
      { company_name: 'Acme Robotics' },
      { headers: auth }
    );
    expect(result.error).toBeNull();
    expect(result.data?.status).toBe(UserStatusEnum.ACTIVE);
    expect(result.data?.company_id).toBeTruthy();

    const profile = await api.auth.profile.get({ $headers: auth });
    expect(profile.data?.company_id).toBe(result.data?.company_id as string);
    expect(profile.data?.status).toBe(UserStatusEnum.ACTIVE);
  });

  test('join endpoint links the user to an existing company', async () => {
    const ownerToken = await authenticate('company-owner@cc-forge.test');
    const created = await api.companies.post(
      { name: 'Globex' },
      { headers: { authorization: `Bearer ${ownerToken}` } }
    );
    const companyId = created.data?.id as string;

    const joinerToken = await authenticate('company-joiner@cc-forge.test');
    const joinerAuth = { authorization: `Bearer ${joinerToken}` };
    const result = await api.onboarding.join.post(
      { company_id: companyId },
      { headers: joinerAuth }
    );
    expect(result.error).toBeNull();
    expect(result.data?.company_id).toBe(companyId);
    expect(result.data?.status).toBe(UserStatusEnum.ACTIVE);
  });

  test('join endpoint with an unknown company is rejected', async () => {
    const token = await authenticate('bad-join@cc-forge.test');
    const result = await api.onboarding.join.post(
      { company_id: '00000000-0000-0000-0000-000000000000' },
      { headers: { authorization: `Bearer ${token}` } }
    );
    expect(result.error?.status as number).toBe(404);
  });

  test('onboarding without a token is rejected', async () => {
    const result = await api.onboarding.create.post({ company_name: 'Nope' });
    expect(result.error?.status as number).toBe(401);
  });

  test('create endpoint with a blank company name is rejected', async () => {
    const token = await authenticate('blank-name@cc-forge.test');
    const result = await api.onboarding.create.post(
      { company_name: '' },
      { headers: { authorization: `Bearer ${token}` } }
    );
    expect(result.error?.status as number).toBe(422);
  });

  test('join endpoint with a malformed company id is rejected', async () => {
    const token = await authenticate('bad-join-id@cc-forge.test');
    const result = await api.onboarding.join.post(
      { company_id: 'not-a-uuid' },
      { headers: { authorization: `Bearer ${token}` } }
    );
    expect(result.error?.status as number).toBe(422);
  });

  test('re-onboarding after activation is rejected', async () => {
    const token = await authenticate('reonboard@cc-forge.test');
    const auth = { authorization: `Bearer ${token}` };

    const first = await api.onboarding.create.post({ company_name: 'First Co' }, { headers: auth });
    expect(first.data?.status).toBe(UserStatusEnum.ACTIVE);
    const companyId = first.data?.company_id as string;

    const secondCreate = await api.onboarding.create.post(
      { company_name: 'Second Co' },
      { headers: auth }
    );
    expect(secondCreate.error?.status as number).toBe(409);

    const rejoin = await api.onboarding.join.post({ company_id: companyId }, { headers: auth });
    expect(rejoin.error?.status as number).toBe(409);
  });
});
