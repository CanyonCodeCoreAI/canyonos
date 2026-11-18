// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute, Outlet, redirect, useRouter } from '@tanstack/react-router';

import { signInRequired, storedKeyAccepted } from '@/modules/auth/auth.routing';
import { useAuthStore } from '@/modules/auth/auth.store';
import { AppLayout } from '@/modules/core/components/AppLayout';
import { QueryError } from '@/modules/core/components/QueryError';

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: async ({ context, location }) => {
    if (!(await signInRequired(context.queryClient))) {
      useAuthStore.getState().logout();
      return;
    }
    if (await storedKeyAccepted(context.queryClient)) return;
    useAuthStore.getState().logout();
    throw redirect({ to: '/login', search: { redirect: location.href } });
  },
  errorComponent: ({ reset }) => <DashboardError reset={reset} />,
  component: () => (
    <AppLayout>
      <Outlet />
    </AppLayout>
  ),
});

function DashboardError({ reset }: { readonly reset: () => void }) {
  const router = useRouter();

  return (
    <QueryError
      message="The dashboard could not load. Check that its API is up, then retry."
      onRetry={() => void router.invalidate().then(reset)}
      className="m-7"
      test_id="dashboard-error"
      retry_test_id="dashboard-retry"
    />
  );
}
