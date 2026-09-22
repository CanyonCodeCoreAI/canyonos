import { DotLottie } from '@lottiefiles/dotlottie-web';
import type { ReactNode } from 'react';

import { cn } from '@repo/ui/utils';

// Instantiate the player once the <canvas> mounts, and tear it down on unmount (React 19 ref
// cleanup). It only needs the mounted node — no props/state — so it lives at module scope with a
// stable identity: no useEffect, no re-init on re-render.
function playLostAstronaut(canvas: HTMLCanvasElement | null) {
  if (!canvas) return;
  const dotLottie = new DotLottie({
    canvas,
    src: '/lost-astronaut.lottie',
    autoplay: true,
    loop: true,
    renderConfig: { autoResize: true },
  });
  return () => dotLottie.destroy();
}

// `section` is the same surface scaled for an empty panel inside a populated screen, so a
// dashboard with five independent sections doesn't stack five full-page astronauts.
const SIZE_CLASS = {
  page: { root: 'flex-1 gap-3 p-10', canvas: 'size-56' },
  section: { root: 'gap-2 p-6', canvas: 'size-24' },
} as const;

interface EmptyStateProps {
  children: ReactNode;
  size?: keyof typeof SIZE_CLASS;
  className?: string;
  test_id?: string;
}

export function EmptyState({
  children,
  size = 'page',
  className,
  test_id = 'empty-state',
}: EmptyStateProps) {
  const sizing = SIZE_CLASS[size];
  return (
    <div
      className={cn(
        'text-muted-foreground flex flex-col items-center justify-center text-sm',
        sizing.root,
        className
      )}
      data-testid={test_id}
    >
      <canvas ref={playLostAstronaut} className={sizing.canvas} tabIndex={-1} aria-hidden />
      {children}
    </div>
  );
}
