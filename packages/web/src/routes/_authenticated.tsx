// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute, Outlet, redirect, useRouter } from '@tanstack/react-router';

import { answeredWith } from '@/api';
import { tokenInfoQuery } from '@/modules/auth/auth.queries';
import { signInRequired } from '@/modules/auth/auth.routing';
import { authActions, useAuthStore } from '@/modules/auth/auth.store';
import { AppLayout } from '@/modules/core/components/AppLayout';
import { QueryError } from '@/modules/core/components/QueryError';

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: async ({ context, location }) => {
    if (!(await signInRequired(context.queryClient))) {
      useAuthStore.getState().logout();
      return;
    }
    const checks = authActions
      .heldTokens()
      .map((token) => context.queryClient.ensureQueryData(tokenInfoQuery(token)));
    // Only the API's refusal ends the session: an API that is down or restarting (`canyonos serve`
    // recreates it) keeps the tokens, and the page says it could not check them.
    const accepted = await Promise.all(checks).then(
      () => checks.length > 0,
      (error: unknown) => {
        if (answeredWith(error, 401, 403)) return false;
        throw error;
      }
    );
    if (accepted) return;
    useAuthStore.getState().logout();
    throw redirect({ to: '/login', search: { redirect: location.href } });
  },
  errorComponent: ({ error, reset }) => <DashboardError error={error} reset={reset} />,
  component: () => (
    <AppLayout>
      <Outlet />
    </AppLayout>
  ),
});

function DashboardError({ error, reset }: { readonly error: unknown; readonly reset: () => void }) {
  const router = useRouter();

  return (
    <QueryError
      error={error}
      message="The dashboard could not load. Check that its API is up, then retry."
      onRetry={() => void router.invalidate().then(reset)}
      className="m-7"
      test_id="dashboard-error"
      retry_test_id="dashboard-retry"
    />
  );
}
