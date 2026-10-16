// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { queryOptions } from '@tanstack/react-query';

import type { AuthStatus, User } from '@canyonos/api/auth';

import { apiCall, forgeAuthApi, forgePublicApi } from '@/api';

export const authStatusQuery = queryOptions({
  queryKey: ['auth', 'status'],
  queryFn: () => apiCall<AuthStatus>(() => forgePublicApi.auth.status.get()),
  staleTime: 0,
});

/** Keyed by token so a new session never reads the previous session's profile. */
export const profileQuery = (token: string) =>
  queryOptions({
    queryKey: ['auth', 'profile', token],
    queryFn: () => apiCall<User>(() => forgeAuthApi.auth.profile.get()),
  });
