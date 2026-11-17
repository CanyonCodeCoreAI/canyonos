// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from '@tanstack/react-router';
import { z } from 'zod';
import type { QueryClient } from '@tanstack/react-query';

import { authStatusQuery } from '@/modules/auth/auth.queries';
import { authActions, useAuthStore } from '@/modules/auth/auth.store';

/** Same-origin paths only: anything else would let a crafted link send a fresh session off-site. */
const localPath = z
  .string()
  .refine((path) => path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\'));

export const authSearchSchema = z.object({
  redirect: localPath.optional().catch(undefined),
});
export type AuthSearch = z.infer<typeof authSearchSchema>;

/** False only for an API started with `AUTH_DISABLED=true`, where nobody needs a token. */
export async function signInRequired(queryClient: QueryClient): Promise<boolean> {
  const { disabled } = await queryClient.ensureQueryData(authStatusQuery);
  return !disabled;
}

/**
 * The token screen is for visitors of an API that verifies tokens and who hold none it can use;
 * anyone else continues where they were going.
 */
export async function leaveIfSignedIn(queryClient: QueryClient, search: AuthSearch): Promise<void> {
  if (!(await signInRequired(queryClient))) throw redirect({ to: '/' });
  if (!authActions.isAuthenticated()) {
    useAuthStore.getState().logout();
    return;
  }
  if (search.redirect) throw redirect({ href: search.redirect });
  throw redirect({ to: '/' });
}
