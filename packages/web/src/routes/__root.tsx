import { createRootRouteWithContext, Outlet, redirect } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';

import { authActions, useAuthStore } from '@/modules/auth/auth.store';
import { signInAsCanyonOsAdmin } from '@/modules/core/canyonos/local-mode';

interface RouterContext {
  queryClient: QueryClient;
}

const PUBLIC_PATHS = ['/login'];

const signInFailureMessage = (error: unknown): string =>
  error instanceof Error && error.message
    ? error.message
    : 'Could not start the local CanyonOS session.';

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ location, preload }) => {
    if (PUBLIC_PATHS.includes(location.pathname)) return;
    if (authActions.isAuthenticated()) return;

    useAuthStore.getState().logout();
    // A preload is a hover, not an arrival: signing in there would open a session for a screen
    // nobody has asked for.
    if (preload) return;

    // Held rather than thrown from inside the catch: `signInAsCanyonOsAdmin` can itself throw a
    // redirect, and rethrowing from the catch would report that as a sign-in failure.
    let failure: string | null = null;
    try {
      await signInAsCanyonOsAdmin();
    } catch (error) {
      failure = signInFailureMessage(error);
    }
    if (failure !== null) {
      throw redirect({ to: '/login', search: { redirect: location.href, local_error: failure } });
    }
  },
  component: () => <Outlet />,
});
