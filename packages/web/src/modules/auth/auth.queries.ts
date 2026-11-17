// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { queryOptions } from '@tanstack/react-query';

import type { AuthStatus, TokenInfo } from '@canyonos/api/auth';

import { apiCall, forgePublicApi } from '@/api';

export const authStatusQuery = queryOptions({
  queryKey: ['auth', 'status'],
  queryFn: () => apiCall<AuthStatus>(() => forgePublicApi.auth.status.get()),
  staleTime: 0,
});

/** What the API makes of `token`, sent as the bearer whichever tokens this browser holds. */
export const tokenInfoQuery = (token: string) =>
  queryOptions({
    queryKey: ['auth', 'token', token],
    queryFn: () =>
      apiCall<TokenInfo>(() =>
        forgePublicApi.auth.token.get({ $headers: { authorization: `Bearer ${token}` } })
      ),
    retry: false,
  });
