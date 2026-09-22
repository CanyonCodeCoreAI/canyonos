import { sleep } from 'bun';
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { db } from '@api/db/client';
import { projects, users } from '@api/db/schema';
import { ADMIN_EMAIL, ensure_canyonos_project } from '@api/modules/canyonos/canyonos.bootstrap';
import { config } from '@core/env';

import { api, setupE2ETests } from './e2e.setup';
import { bearer } from './project-test.utils';

setupE2ETests();

const MAILPIT_API = 'http://localhost:8025/api/v1';
// Mailpit keeps messages between runs, so each run needs its own address or it reads a stale code.
const RUN_ID = Bun.randomUUIDv7();

interface MailpitMessage {
  ID: string;
}

async function sign_in_with_mailed_code(email: string): Promise<string> {
  const challenge = await api.auth.challenge.post({ email });
  expect(challenge.error).toBeNull();

  const code = await read_latest_code_for(email);
  const verify = await api.auth.verify.post({ email, code });
  expect(verify.error).toBeNull();
  return verify.data!.token;
}

/** Poll Mailpit for the most recent message to `email` and pull the 6-digit code out of its body. */
async function read_latest_code_for(email: string): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const search = await fetch(`${MAILPIT_API}/search?query=${encodeURIComponent(`to:${email}`)}`);
    const { messages } = (await search.json()) as { messages: MailpitMessage[] };
    const latest = messages[0];
    if (latest) {
      const message = await fetch(`${MAILPIT_API}/message/${latest.ID}`);
      const { HTML, Text } = (await message.json()) as { HTML: string; Text: string };
      const match = (HTML || Text).match(/(\d{6})/);
      if (match?.[1]) return match[1];
    }
    await sleep(200);
  }
  throw new Error(`No verification email arrived for ${email} via Mailpit`);
}

describe('AUTH_MODE=email_otp signs in over real SMTP', () => {
  test('the suite runs with AUTH_MODE=email_otp', () => {
    expect(config.auth.mode).toBe('email_otp');
  });

  test('the fixed code 111111 is rejected for an @canyonos.test address', async () => {
    const email = 'authon-reject@canyonos.test';
    const challenge = await api.auth.challenge.post({ email });
    expect(challenge.error).toBeNull();

    const verify = await api.auth.verify.post({ email, code: '111111' });

    expect(verify.error?.status as number).toBe(401);
  });

  test('a real OTP delivered over SMTP signs in', async () => {
    const email = `authon-real-otp-${RUN_ID}@canyonos.test`;
    const challenge = await api.auth.challenge.post({ email });
    expect(challenge.error).toBeNull();

    const code = await read_latest_code_for(email);
    const verify = await api.auth.verify.post({ email, code });

    expect(verify.error).toBeNull();
    expect(verify.data?.token).toBeString();
    expect(verify.data?.user.email).toBe(email);
  });

  test('the bootstrapped admin exists but the fixed code is rejected for it', async () => {
    const [admin] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, ADMIN_EMAIL))
      .limit(1);
    expect(admin).toBeDefined();

    const verify = await api.auth.verify.post({ email: ADMIN_EMAIL, code: '111111' });

    expect(verify.error?.status as number).toBe(401);
  });

  test('the controller project is bootstrapped under the admin, who never signs in', async () => {
    const project_id = '55555555-5555-4555-8555-555555555555';
    expect(await ensure_canyonos_project(project_id)).toBe(true);

    const [admin] = await db
      .select({ id: users.id, company_id: users.companyId })
      .from(users)
      .where(eq(users.email, ADMIN_EMAIL))
      .limit(1);
    const [project] = await db
      .select({ company_id: projects.company_id, created_by: projects.created_by })
      .from(projects)
      .where(eq(projects.id, project_id))
      .limit(1);

    expect(project?.company_id).toBe(admin!.company_id!);
    expect(project?.created_by).toBe(admin!.id);
  });

  test('two users who signed in with a mailed code both list and open that project', async () => {
    const project_id = '66666666-6666-4666-8666-666666666666';
    expect(await ensure_canyonos_project(project_id)).toBe(true);

    const first = await sign_in_with_mailed_code(`authon-reader-${RUN_ID}@canyonos.test`);
    const second = await sign_in_with_mailed_code(`authon-second-reader-${RUN_ID}@canyonos.test`);

    for (const token of [first, second]) {
      const listed = await api.projects.get({ $headers: bearer(token) });
      expect(listed.error).toBeNull();
      expect(listed.data!.map((project) => project.id)).toContain(project_id);

      const detail = await api.projects[project_id]!.get({ $headers: bearer(token) });
      expect(detail.error).toBeNull();
      expect(detail.data?.name).toBe('project_1');
    }
  });

  test('POST /v1/traces stays unauthenticated', async () => {
    const response = await fetch(`${config.app.apiUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: new Uint8Array(),
    });

    expect(response.status).toBe(200);
  });
});
