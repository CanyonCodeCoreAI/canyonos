// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute, redirect } from '@tanstack/react-router';

import { authStatusQuery } from '@/modules/auth/auth.queries';
import { authSearchSchema, leaveIfSignedIn } from '@/modules/auth/auth.routing';
import { RegisterScreen } from '@/modules/auth/screens/RegisterScreen';
import type { BrandCopy } from '@/modules/auth/components/CanyonBrandPanel';

const REGISTER_BRAND: BrandCopy = {
  eyebrow: 'First run',
  title: 'Set up the first account.',
  description:
    'Anyone with an account on this dashboard sees every project it runs. Registration closes once this account exists.',
  footnote: 'Takes ten seconds.',
};

export const Route = createFileRoute('/_brand/register')({
  validateSearch: authSearchSchema,
  beforeLoad: ({ context, search }) => leaveIfSignedIn(context.queryClient, search),
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps }) => {
    const { has_users } = await context.queryClient.fetchQuery(authStatusQuery);
    if (has_users) throw redirect({ to: '/login', search: deps });
  },
  staticData: { brand: REGISTER_BRAND },
  component: RegisterScreen,
});
