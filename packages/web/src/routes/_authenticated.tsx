import { queryOptions } from '@tanstack/react-query';
import { createFileRoute, Outlet } from '@tanstack/react-router';

import type { User } from '@canyonos/api/auth';

import { apiCall, forgeAuthApi } from '@/api';
import { authActions, useAuthStore } from '@/modules/auth/auth.store';
import { AppLayout } from '@/modules/core/components/AppLayout';

export const Route = createFileRoute('/_authenticated')({
  loader: ({ context }) => {
    void context.queryClient
      .fetchQuery(
        queryOptions({
          queryKey: ['auth', 'profile'],
          queryFn: () => apiCall<User>(() => forgeAuthApi.auth.profile.get()),
          staleTime: 0,
        })
      )
      .then((user) => authActions.setUser(user))
      .catch(() => useAuthStore.getState().logout());
  },
  component: () => (
    <AppLayout>
      <Outlet />
    </AppLayout>
  ),
});
