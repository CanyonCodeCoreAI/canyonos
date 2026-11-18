// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';
import type { Query } from '@tanstack/react-query';

import { answeredWith } from '@/api';
import { authActions, useAuthStore } from '@/modules/auth/auth.store';
import { routeTree } from '@/routeTree.gen';
import type { BrandCopy } from '@/modules/auth/components/CanyonBrandPanel';

const QUERY_RETRIES = 3;

/**
 * A 401 in a session means the stored key stopped working, as a new key on this machine leaves it:
 * forget it and let the root guard send the person to sign in, back to this page after. The key
 * checks under `['auth']` are left to the sign-in guard that asked them.
 */
function signOutWhenRefused(error: unknown, query?: Query<unknown, unknown, unknown>): void {
  if (!answeredWith(error, 401) || query?.queryKey[0] === 'auth') return;
  if (!authActions.isAuthenticated()) return;
  useAuthStore.getState().logout();
  void router.invalidate();
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: (error, query) => signOutWhenRefused(error, query) }),
  mutationCache: new MutationCache({ onError: (error) => signOutWhenRefused(error) }),
  defaultOptions: {
    queries: {
      // Another try with the same key gets the same refusal.
      retry: (failures, error) => !answeredWith(error, 401) && failures < QUERY_RETRIES,
    },
  },
});

export const router = createRouter({ routeTree, context: { queryClient } });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }

  interface StaticDataRouteOption {
    brand?: BrandCopy;
  }
}
