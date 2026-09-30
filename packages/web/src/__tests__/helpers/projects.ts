import type { Route } from '@playwright/test';

export const apiBaseUrl = process.env.VITE_API_URL ?? 'http://localhost:3000';

export async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

export async function failJson(route: Route, message = 'Controlled test failure'): Promise<void> {
  await fulfillJson(route, { error: 'test.failure', message }, 500);
}
