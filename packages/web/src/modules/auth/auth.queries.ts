// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { queryOptions } from '@tanstack/react-query';

import type { AuthCheck, AuthStatus } from '@canyonos/api/auth';

import { apiCall, forgePublicApi } from '@/api';

export const authStatusQuery = queryOptions({
  queryKey: ['auth', 'status'],
  queryFn: () => apiCall<AuthStatus>(() => forgePublicApi.auth.status.get()),
  staleTime: 0,
});

/** Whether the API takes `apiKey`, sent as the bearer whatever key this browser holds. */
export const apiKeyCheckQuery = (apiKey: string) =>
  queryOptions({
    queryKey: ['auth', 'check', apiKey],
    queryFn: () =>
      apiCall<AuthCheck>(() =>
        forgePublicApi.auth.check.get({ $headers: { authorization: `Bearer ${apiKey}` } })
      ),
    retry: false,
  });
