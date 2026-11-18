// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute } from '@tanstack/react-router';

import { authSearchSchema, leaveIfSignedIn } from '@/modules/auth/auth.routing';
import { signInWithLink } from '@/modules/auth/auth.sign-in';
import { TokenScreen } from '@/modules/auth/screens/TokenScreen';
import type { BrandCopy } from '@/modules/auth/components/CanyonBrandPanel';

const LOGIN_BRAND: BrandCopy = {
  eyebrow: 'Self-hosted',
  title: 'Every deployment this install runs, in one place.',
  description:
    'Deployments, scaling policies, prompts and spend for the agents on this controller.',
  footnote: 'Sign in to pick up where you left off.',
};

export const Route = createFileRoute('/_brand/login')({
  validateSearch: authSearchSchema,
  beforeLoad: async ({ context, location, search }) => {
    const linkError = await signInWithLink(context.queryClient, location, search);
    await leaveIfSignedIn(context.queryClient, search);
    return { linkError };
  },
  staticData: { brand: LOGIN_BRAND },
  component: TokenScreen,
});
