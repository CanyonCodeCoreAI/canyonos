// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute, redirect } from '@tanstack/react-router';

import { authSearchSchema } from '@/modules/auth/auth.routing';

/** Accounts are gone; an old bookmark to the sign-up page lands on the sign-in screen. */
export const Route = createFileRoute('/register')({
  validateSearch: authSearchSchema,
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/login', search });
  },
});
