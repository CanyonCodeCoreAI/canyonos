// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';

import { profileQuery } from '@/modules/auth/auth.queries';
import { authActions, useAuthStore } from '@/modules/auth/auth.store';
import { AppLayout } from '@/modules/core/components/AppLayout';

export const Route = createFileRoute('/_authenticated')({
  loader: async ({ context, location }) => {
    const token = authActions.getToken() ?? '';
    const user = await context.queryClient.ensureQueryData(profileQuery(token)).catch(() => null);
    if (user) {
      authActions.setUser(user);
      return;
    }
    useAuthStore.getState().logout();
    throw redirect({ to: '/login', search: { redirect: location.href } });
  },
  component: () => (
    <AppLayout>
      <Outlet />
    </AppLayout>
  ),
});
