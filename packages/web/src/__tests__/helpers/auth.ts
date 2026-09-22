import type { Page } from '@playwright/test';

const apiBaseUrl = process.env.VITE_API_URL ?? 'http://localhost:3000';

const base64Url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

const makeToken = (expSeconds: number) =>
  `${base64Url({ alg: 'HS256', typ: 'JWT' })}.${base64Url({ exp: expSeconds })}.signature`;

const nowSeconds = Math.floor(Date.now() / 1000);

// Synthetic (unsigned) tokens for exercising the client-side auth guard in isolation. The
// guard only decodes `exp`, so it never needs a real signature — these let the auth-routing
// specs assert accept/redirect behaviour without a live session. Specs that actually talk to
// the API must authenticate for real via `authenticate()`.
export const validToken = makeToken(nowSeconds + 3600);
export const expiredToken = makeToken(nowSeconds - 3600);

export const setToken = (token: string) =>
  localStorage.setItem(
    'cc-auth-storage',
    JSON.stringify({ state: { user: { id: '1', email: 'test@canyonos.test' }, token }, version: 0 })
  );

const persistAuth = (session: { user: unknown; token: string }) =>
  localStorage.setItem('cc-auth-storage', JSON.stringify({ state: session, version: 0 }));

export interface AuthSession {
  readonly user: unknown;
  readonly token: string;
}

// Authenticate through the real API using the `@canyonos.test` OTP bypass (code `111111`),
// then seed the returned token so the app boots already signed in. The token is genuinely
// signed, so the authenticated layout's `/auth/profile` lookup succeeds on its own — no
// route stubbing, and the session survives client-side navigation.
export async function authenticate(page: Page, email = 'e2e@canyonos.test'): Promise<AuthSession> {
  const response = await page.request.post(`${apiBaseUrl}/auth/verify`, {
    data: { email, code: '111111' },
  });
  if (!response.ok()) {
    throw new Error(`Test authentication failed (${response.status()}): ${await response.text()}`);
  }
  const session = (await response.json()) as AuthSession;
  await page.addInitScript(persistAuth, session);
  return session;
}
