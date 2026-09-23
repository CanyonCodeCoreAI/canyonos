import { createFileRoute, redirect } from '@tanstack/react-router';

import { UserStatusEnum } from '@canyonos/api/auth';

import { authActions } from '@/modules/auth/auth.store';
import { OnboardingScreen } from '@/modules/onboarding/screens/OnboardingScreen';
import type { BrandCopy } from '@/modules/auth/components/CanyonBrandPanel';

const ONBOARDING_BRAND: BrandCopy = {
  eyebrow: 'Set up your workspace',
  title: 'Tell us about your company.',
  description:
    "CanyonOS runs agentic workloads under your organization's governance and identity rules. We use these legal details to provision your tenant and keep compute compliant.",
  footnote: 'Takes about two minutes.',
};

export const Route = createFileRoute('/_brand/onboarding')({
  beforeLoad: () => {
    if (authActions.getUser()?.status === UserStatusEnum.ACTIVE) {
      throw redirect({ to: '/' });
    }
  },
  staticData: { brand: ONBOARDING_BRAND },
  component: OnboardingScreen,
});
