import { useActorRef, useSelector } from '@xstate/react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

import { slideVariants } from '@/modules/core/utils/motion.config';
import { onboardingMachine } from '@/modules/onboarding/onboarding.machine';
import { CreateCompanyStep } from '@/modules/onboarding/screens/steps/CreateCompanyStep';
import { SelectCompanyStep } from '@/modules/onboarding/screens/steps/SelectCompanyStep';
import type { OnboardingMachineActorRef } from '@/modules/onboarding/onboarding.machine';

type Step = 'select' | 'create';

function renderStep(step: Step, actorRef: OnboardingMachineActorRef) {
  switch (step) {
    case 'create':
      return <CreateCompanyStep actorRef={actorRef} />;
    case 'select':
      return <SelectCompanyStep actorRef={actorRef} />;
  }
}

export function OnboardingScreen() {
  const actorRef = useActorRef(onboardingMachine);
  const shouldReduceMotion = useReducedMotion();
  const step = useSelector(
    actorRef,
    (state): Step => (state.matches('create') || state.matches('creating') ? 'create' : 'select')
  );

  return (
    <AnimatePresence mode="wait" initial={!shouldReduceMotion}>
      <motion.div
        key={step}
        variants={shouldReduceMotion ? undefined : slideVariants}
        initial={shouldReduceMotion ? false : 'hiddenRight'}
        animate={shouldReduceMotion ? undefined : 'visible'}
        exit={shouldReduceMotion ? undefined : 'exitLeft'}
      >
        {renderStep(step, actorRef)}
      </motion.div>
    </AnimatePresence>
  );
}
