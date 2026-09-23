import { useActorRef, useSelector } from '@xstate/react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

import { authMachine } from '@/modules/auth/auth.machine';
import { EnterCodeStep } from '@/modules/auth/screens/steps/EnterCodeStep';
import { EnterEmailStep } from '@/modules/auth/screens/steps/EnterEmailStep';
import { slideVariants } from '@/modules/core/utils/motion.config';

export function AuthScreen() {
  const actorRef = useActorRef(authMachine);
  const shouldReduceMotion = useReducedMotion();
  const screen = useSelector(actorRef, (state) => (state.matches('code') ? 'code' : 'email'));

  const renderStep = () => {
    switch (screen) {
      case 'email':
        return <EnterEmailStep actorRef={actorRef} />;
      case 'code':
        return <EnterCodeStep actorRef={actorRef} />;
      default:
        throw new Error(`Unhandled auth screen: ${String(screen)}`);
    }
  };

  return (
    <AnimatePresence mode="wait" initial={!shouldReduceMotion}>
      <motion.div
        key={screen}
        variants={shouldReduceMotion ? undefined : slideVariants}
        initial={shouldReduceMotion ? false : 'hiddenRight'}
        animate={shouldReduceMotion ? undefined : 'visible'}
        exit={shouldReduceMotion ? undefined : 'exitLeft'}
      >
        {renderStep()}
      </motion.div>
    </AnimatePresence>
  );
}
