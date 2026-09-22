import type { Variants } from 'framer-motion';

const ENTER_DELAY = 0.05;

export const slideVariants: Variants = {
  hiddenRight: { opacity: 0, x: 40 },
  visible: {
    opacity: 1,
    x: 0,
    transition: { duration: 0.24, delay: ENTER_DELAY, ease: [0.23, 1, 0.32, 1] },
  },
  exitLeft: {
    opacity: 0,
    x: -40,
    transition: { duration: 0.18, ease: [0.77, 0, 0.175, 1] },
  },
};
