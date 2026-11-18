// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import type { ParsedLocation } from '@tanstack/react-router';

import { answeredWith } from '@/api';
import { apiKeyCheckQuery } from '@/modules/auth/auth.queries';
import { useAuthStore } from '@/modules/auth/auth.store';
import type { AuthSearch } from '@/modules/auth/auth.routing';

declare module '@tanstack/react-router' {
  interface HistoryState {
    /** Why the API refused the key of the link whose history entry this one replaced. */
    linkRefusal?: { reason: string };
  }
}

/** Resolves once the API takes `apiKey`; rejects with its refusal. */
export async function checkApiKey(queryClient: QueryClient, apiKey: string): Promise<void> {
  await queryClient.fetchQuery(apiKeyCheckQuery(apiKey));
}

/**
 * The key `canyonos dashboard` hands over as `#key=…`: a fragment, which no request carries, so it
 * never reaches a server's logs. Read from the address as it was typed, since the router's
 * `hash` is already percent-decoded and would decode the key twice.
 */
function linkApiKey(location: ParsedLocation): string | null {
  const { hash } = new URL(location.publicHref, window.location.origin);
  return new URLSearchParams(hash.slice(1)).get('key')?.trim() || null;
}

/**
 * Signs in with the key of a `canyonos dashboard` link and goes on where the visitor was going.
 * Either way it leaves through a redirect that replaces the link's history entry, which takes the
 * key out of the address bar: the router reloads on any change to the address, so stripping it by
 * hand would start a second load that drops this one. Returns why the API refused the key of the
 * link this entry replaced, or null.
 */
export async function signInWithLink(
  queryClient: QueryClient,
  location: ParsedLocation,
  search: AuthSearch
): Promise<Error | null> {
  const apiKey = linkApiKey(location);
  if (!apiKey) {
    const refusal = location.state.linkRefusal;
    return refusal ? new Error(refusal.reason) : null;
  }
  try {
    await checkApiKey(queryClient, apiKey);
  } catch (error) {
    if (!answeredWith(error, 401)) throw error;
    throw redirect({
      to: '/login',
      search,
      replace: true,
      state: { linkRefusal: { reason: error.message } },
    });
  }
  useAuthStore.getState().login(apiKey);
  throw redirect({ href: search.redirect ?? '/', replace: true });
}
