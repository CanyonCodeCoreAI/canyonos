import { useEffect, useRef, useState } from 'react';

import type { MetricsWindow } from '@cc-forge/api/metrics';

import { TimeRangeToggle } from '@repo/ui/components/time-range-toggle';
import { HeaderDockPortal } from '@/modules/core/navigation/header-dock';
import { isMetricsWindow, METRICS_WINDOW_OPTIONS } from '@/modules/projects/projects.metrics';

// Below this the header already carries the sidebar trigger, the workspace link, the project
// breadcrumb and two deploy buttons; four more segments would overflow it, so the control stays in
// the hero and the reader scrolls up to reach it.
const DOCK_MIN_WIDTH = 1024;

// Reserves the control's box in the hero whether or not the control is currently in it. Load-bearing
// rather than cosmetic: this is the element the observer watches, so its height must not depend on
// docking — otherwise docking would move it, re-fire the observer, and oscillate.
const HERO_SLOT = 'flex h-10 shrink-0 items-center';

interface ProjectWindowControlProps {
  readonly value: MetricsWindow;
  readonly onChange: (time_window: MetricsWindow) => void;
}

/**
 * The metrics window toggle, which rides up into the app header once the hero scrolls away.
 *
 * Every section of the dashboard reads this window and the page is several screens tall, so the
 * control has to survive scrolling. It is portalled — not duplicated — into the header dock: one
 * instance means one test id, one focus target, and no second copy to keep in sync. The cost is that
 * crossing the portal boundary remounts it, so keyboard focus does not follow the handoff; the
 * handoff is caused by scrolling, so nothing was focused when it happens.
 */
export function ProjectWindowControl({ value, onChange }: ProjectWindowControlProps) {
  const [docked, setDocked] = useState(false);
  const slot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = slot.current;
    if (!element) return;

    const wide = window.matchMedia(`(min-width: ${DOCK_MIN_WIDTH}px)`);
    // The window itself never scrolls — the app shell is a fixed-height column and the scroll port
    // is an inner element. `root: null` still works, because the intersection rect is clipped by
    // that port: the slot stops intersecting exactly when it passes under the header.
    const observer = new IntersectionObserver(([entry]) => {
      setDocked(wide.matches && entry?.isIntersecting === false);
    });

    // Re-observing delivers a fresh entry, so crossing the breakpoint re-decides with both the
    // current width and the slot's current position — a resize can move the slot too.
    const onWidthChange = () => {
      observer.disconnect();
      observer.observe(element);
    };

    observer.observe(element);
    wide.addEventListener('change', onWidthChange);
    return () => {
      observer.disconnect();
      wide.removeEventListener('change', onWidthChange);
    };
  }, []);

  const toggle = (
    <TimeRangeToggle
      value={value}
      onValueChange={(next) => {
        if (isMetricsWindow(next)) onChange(next);
      }}
      options={METRICS_WINDOW_OPTIONS}
      aria-label="Metrics window"
      data-testid="project-window-toggle"
    />
  );

  return (
    <div ref={slot} className={HERO_SLOT}>
      {docked ? (
        <HeaderDockPortal>
          <div className="animate-in fade-in-0 slide-in-from-top-1 ease-snappy duration-200">
            {toggle}
          </div>
        </HeaderDockPortal>
      ) : (
        toggle
      )}
    </div>
  );
}
