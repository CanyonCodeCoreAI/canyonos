import { createRootRouteWithContext, Outlet, redirect } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';

import { authActions, useAuthStore } from '@/modules/auth/auth.store';
import { isCanyonOsLocalMode, signInAsCanyonOsAdmin } from '@/modules/core/canyonos/local-mode';
import { isCanyonOsLocalRoute } from '@/modules/core/canyonos/local-mode.routes';

interface RouterContext {
  queryClient: QueryClient;
}

const PUBLIC_PATHS = ['/login'];

const signInFailureMessage = (error: unknown): string =>
  error instanceof Error && error.message
    ? error.message
    : 'Could not start the local CanyonOS session.';

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ location, matches, preload }) => {
    // `matches` is the destination chain, so its last entry is the leaf the URL resolves to. A
    // closed route goes home rather than to a screen missing the backend it needs.
    if (isCanyonOsLocalMode && !isCanyonOsLocalRoute(matches[matches.length - 1]?.routeId)) {
      throw redirect({ to: '/' });
    }

    if (PUBLIC_PATHS.includes(location.pathname)) return;
    if (authActions.isAuthenticated()) return;

    useAuthStore.getState().logout();
    if (!isCanyonOsLocalMode) throw redirect({ to: '/login', search: { redirect: location.href } });
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
