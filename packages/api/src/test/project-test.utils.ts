import { expect } from 'bun:test';
import { eq } from 'drizzle-orm';

import { db } from '@api/db/client';
import { users } from '@api/db/schema';
import { deploy_setups_repo } from '@api/modules/deploy/deploy.repo';

import { api } from './e2e.setup';

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export async function authenticate(email: string, onboard = true): Promise<string> {
  await api.auth.challenge.post({ email });
  const verify = await api.auth.verify.post({ email, code: '111111' });
  expect(verify.error).toBeNull();
  const token = verify.data?.token;
  if (!token) throw new Error(`Authentication failed for ${email}`);
  if (onboard) {
    await api.onboarding.create.post(
      { company_name: `Company for ${email}` },
      { headers: bearer(token) }
    );
  }
  return token;
}

export async function add_company_member(owner_token: string, email: string): Promise<string> {
  const token = await authenticate(email, false);
  const owner = await api.auth.profile.get({ $headers: bearer(owner_token) });
  const member = await api.auth.profile.get({ $headers: bearer(token) });
  const company_id = owner.data?.company_id;
  const member_id = member.data?.id;
  if (!company_id || !member_id) throw new Error('Company member fixture could not be created');
  await db
    .update(users)
    .set({ companyId: company_id, status: 'ACTIVE' })
    .where(eq(users.id, member_id));
  return token;
}

export const DEPLOY_SETUP_VALUES = {
  name: 'Mock AWS',
  provider: 'AWS',
  region: 'us-east-1',
  ami_id: 'ami-0123456789abcdef0',
  instance_type: 't2.nano',
  subnet_id: 'subnet-0123456789abcdef0',
  security_group_ids: 'sg-0123456789abcdef0',
  ssh_user: 'ec2-user',
  ssh_private_key_path: '/home/ec2-user/.ssh/key.pem',
} as const;

export async function create_deploy_setup(token: string) {
  const profile = await api.auth.profile.get({ $headers: bearer(token) });
  const company_id = profile.data?.company_id;
  const user_id = profile.data?.id;
  if (!company_id || !user_id) throw new Error('Deploy setup fixture could not be created');
  return deploy_setups_repo.create({
    ...DEPLOY_SETUP_VALUES,
    company_id,
    created_by: user_id,
  });
}
