// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from '@tanstack/react-router';
import { z } from 'zod';

import { authActions, useAuthStore } from '@/modules/auth/auth.store';

/** Same-origin paths only: anything else would let a crafted link send a fresh session off-site. */
const localPath = z
  .string()
  .refine((path) => path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\'));

export const authSearchSchema = z.object({
  redirect: localPath.optional().catch(undefined),
});
export type AuthSearch = z.infer<typeof authSearchSchema>;

/** The sign-in screens are for signed-out visitors; anyone else continues where they were going. */
export function leaveIfSignedIn(search: AuthSearch): void {
  if (!authActions.isAuthenticated()) {
    useAuthStore.getState().logout();
    return;
  }
  if (search.redirect) throw redirect({ href: search.redirect });
  throw redirect({ to: '/' });
}
