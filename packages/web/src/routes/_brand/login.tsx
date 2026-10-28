// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute, redirect } from '@tanstack/react-router';

import { authStatusQuery } from '@/modules/auth/auth.queries';
import { authSearchSchema, leaveIfSignedIn } from '@/modules/auth/auth.routing';
import { LoginScreen } from '@/modules/auth/screens/LoginScreen';
import type { BrandCopy } from '@/modules/auth/components/CanyonBrandPanel';

const LOGIN_BRAND: BrandCopy = {
  eyebrow: 'Self-hosted',
  title: 'Every project this install runs, in one place.',
  description:
    'Deployments, scaling policies, prompts and spend for the agents on this controller.',
  footnote: 'Sign in to pick up where you left off.',
};

export const Route = createFileRoute('/_brand/login')({
  validateSearch: authSearchSchema,
  beforeLoad: ({ context, search }) => leaveIfSignedIn(context.queryClient, search),
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps }) => {
    const { has_users } = await context.queryClient.fetchQuery(authStatusQuery);
    if (!has_users) throw redirect({ to: '/register', search: deps });
  },
  staticData: { brand: LOGIN_BRAND },
  component: LoginScreen,
});
