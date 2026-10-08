import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import { MetricsWindowSchema } from '@canyonos/api/metrics';

import { TimeRangeToggle } from '@repo/ui/components/time-range-toggle';
import { HeaderDockPortal } from '@/modules/core/navigation/header-dock';
import {
  DEFAULT_METRICS_WINDOW,
  isMetricsWindow,
  METRICS_WINDOW_OPTIONS,
} from '@/modules/projects/projects.metrics';

/** The search params of a screen scoped to a metrics window, so a link carries the window it shows. */
export const metricsWindowSearchSchema = z.object({
  time_window: MetricsWindowSchema.default(DEFAULT_METRICS_WINDOW).catch(DEFAULT_METRICS_WINDOW),
});

// shadcn's sidebar goes mobile below this, where the header has no room left for four segments,
// so the control stays in the hero and the reader scrolls up to reach it.
const DOCK_MIN_WIDTH = 768;

// Reserves the control's box in the hero whether or not the control is currently in it. Load-bearing
// rather than cosmetic: this is the element the observer watches, so its height must not depend on
// docking — otherwise docking would move it, re-fire the observer, and oscillate.
const HERO_SLOT = 'flex h-10 shrink-0 items-center';

/**
 * The metrics window toggle, which rides up into the app header once the hero scrolls away.
 *
 * Every section of the dashboard reads this window and the page is several screens tall, so the
 * control has to survive scrolling. It is portalled — not duplicated — into the header dock: one
 * instance means one test id, one focus target, and no second copy to keep in sync. The cost is that
 * crossing the portal boundary remounts it, so keyboard focus does not follow the handoff; the
 * handoff is caused by scrolling, so nothing was focused when it happens. The window itself is the
 * route's `time_window` search param, so it survives reloads and links.
 */
export function ProjectWindowControl() {
  const { time_window = DEFAULT_METRICS_WINDOW } = useSearch({ strict: false });
  const navigate = useNavigate();
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
      value={time_window}
      onValueChange={(next) => {
        if (isMetricsWindow(next)) {
          void navigate({ to: '.', search: (previous) => ({ ...previous, time_window: next }) });
        }
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
