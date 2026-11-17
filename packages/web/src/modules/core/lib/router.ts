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
 * A 401 in a session means a stored token stopped working, as a key rotation leaves it: forget
 * the tokens and let the root guard send the person to the token screen, back to this page after.
 * The token checks under `['auth']` are left to the sign-in guard that asked them.
 */
function signOutWhenRefused(error: unknown, query?: Query<unknown, unknown, unknown>): void {
  if (!answeredWith(error, 401) || query?.queryKey[0] === 'auth') return;
  if (authActions.heldTokens().length === 0) return;
  useAuthStore.getState().logout();
  void router.invalidate();
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: (error, query) => signOutWhenRefused(error, query) }),
  mutationCache: new MutationCache({ onError: (error) => signOutWhenRefused(error) }),
  defaultOptions: {
    queries: {
      // Another try with the same token gets the same refusal.
      retry: (failures, error) => !answeredWith(error, 401, 403) && failures < QUERY_RETRIES,
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
