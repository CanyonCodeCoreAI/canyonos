// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import type { ParsedLocation } from '@tanstack/react-router';

import type { ApiScope } from '@canyonos/api/auth';

import { tokenInfoQuery } from '@/modules/auth/auth.queries';
import { useAuthStore } from '@/modules/auth/auth.store';
import type { AuthSearch } from '@/modules/auth/auth.routing';
import type { ApiTokens } from '@/modules/auth/auth.store';

declare module '@tanstack/react-router' {
  interface HistoryState {
    /** Why the API refused the tokens of the link whose history entry this one replaced. */
    linkRefusal?: { scope: ApiScope; reason: string };
  }
}

export const TOKEN_LABELS = {
  read: 'Read token',
  write: 'Write token',
} as const satisfies Record<ApiScope, string>;

/** A refusal of the token given for one scope, which the message names. */
export class TokenFieldError extends Error {
  constructor(
    readonly scope: ApiScope,
    readonly reason: string
  ) {
    super(`${TOKEN_LABELS[scope]}: ${reason}`);
  }
}

async function checkToken(queryClient: QueryClient, scope: ApiScope, token: string | null) {
  if (!token) return;
  const info = await queryClient.fetchQuery(tokenInfoQuery(token)).catch((error: unknown) => {
    throw new TokenFieldError(scope, error instanceof Error ? error.message : String(error));
  });
  if (info.scope !== scope) {
    throw new TokenFieldError(scope, `This is a ${info.scope} token, not a ${scope} token`);
  }
}

/** Resolves once the API accepts each token given for the scope it was given for. */
export async function checkTokens(queryClient: QueryClient, tokens: ApiTokens): Promise<void> {
  await checkToken(queryClient, 'read', tokens.readToken);
  await checkToken(queryClient, 'write', tokens.writeToken);
}

/**
 * The tokens `canyonos dashboard` hands over as `#read=…&write=…`: a fragment, which no request
 * carries, so they never reach a server's logs.
 */
function linkTokens(hash: string): ApiTokens | null {
  const fragment = new URLSearchParams(hash.replace(/^#/, ''));
  const tokens = { readToken: fragment.get('read'), writeToken: fragment.get('write') };
  if (!tokens.readToken && !tokens.writeToken) return null;
  return tokens;
}

/**
 * Signs in with the tokens of a `canyonos dashboard` link and goes on where the visitor was going.
 * Either way it leaves through a redirect that replaces the link's history entry, which takes the
 * tokens out of the address bar: the router reloads on any change to the address, so stripping
 * them by hand would start a second load that drops this one. Returns why the API refused the
 * tokens of the link this entry replaced, or null.
 */
export async function signInWithLink(
  queryClient: QueryClient,
  location: ParsedLocation,
  search: AuthSearch
): Promise<TokenFieldError | null> {
  const tokens = linkTokens(location.hash);
  if (!tokens) {
    const refusal = location.state.linkRefusal;
    return refusal ? new TokenFieldError(refusal.scope, refusal.reason) : null;
  }
  try {
    await checkTokens(queryClient, tokens);
  } catch (error) {
    if (!(error instanceof TokenFieldError)) throw error;
    throw redirect({
      to: '/login',
      search,
      replace: true,
      state: { linkRefusal: { scope: error.scope, reason: error.reason } },
    });
  }
  useAuthStore.getState().login(tokens);
  throw redirect({ href: search.redirect ?? '/', replace: true });
}
