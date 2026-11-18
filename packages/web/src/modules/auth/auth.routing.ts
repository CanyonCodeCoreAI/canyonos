// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from '@tanstack/react-router';
import { z } from 'zod';
import type { QueryClient } from '@tanstack/react-query';

import { answeredWith } from '@/api';
import { apiKeyCheckQuery, authStatusQuery } from '@/modules/auth/auth.queries';
import { authActions } from '@/modules/auth/auth.store';

/** Same-origin paths only: anything else would let a crafted link send a fresh session off-site. */
const localPath = z
  .string()
  .refine((path) => path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\'));

export const authSearchSchema = z.object({
  redirect: localPath.optional().catch(undefined),
});
export type AuthSearch = z.infer<typeof authSearchSchema>;

/** False only for an API started with no `CANYONOS_API_KEY_HASH`, where nobody needs a key. */
export async function signInRequired(queryClient: QueryClient): Promise<boolean> {
  const { api_key_required } = await queryClient.ensureQueryData(authStatusQuery);
  return api_key_required;
}

/**
 * Whether the API takes the stored key. Only its refusal ends the session: an API that is down or
 * restarting (`canyonos serve` recreates it) keeps the key, and the page says it could not check.
 */
export async function storedKeyAccepted(queryClient: QueryClient): Promise<boolean> {
  const apiKey = authActions.apiKey();
  if (!apiKey) return false;
  try {
    await queryClient.ensureQueryData(apiKeyCheckQuery(apiKey));
    return true;
  } catch (error) {
    if (answeredWith(error, 401)) return false;
    throw error;
  }
}

/**
 * The sign-in screen is for visitors of an API that needs a key and who hold none; anyone else
 * continues where they were going.
 */
export async function leaveIfSignedIn(queryClient: QueryClient, search: AuthSearch): Promise<void> {
  if (!(await signInRequired(queryClient))) throw redirect({ to: '/' });
  if (!authActions.isAuthenticated()) return;
  if (search.redirect) throw redirect({ href: search.redirect });
  throw redirect({ to: '/' });
}
