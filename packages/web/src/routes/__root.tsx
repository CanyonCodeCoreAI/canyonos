// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createRootRouteWithContext, Outlet, redirect } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';

import { signInRequired } from '@/modules/auth/auth.routing';
import { authActions, useAuthStore } from '@/modules/auth/auth.store';

interface RouterContext {
  queryClient: QueryClient;
}

const PUBLIC_PATHS = ['/login', '/register'];

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ context, location }) => {
    if (PUBLIC_PATHS.includes(location.pathname)) return;
    if (!(await signInRequired(context.queryClient))) return;
    if (authActions.isAuthenticated()) return;

    useAuthStore.getState().logout();
    throw redirect({ to: '/login', search: { redirect: location.href } });
  },
  component: () => <Outlet />,
});
