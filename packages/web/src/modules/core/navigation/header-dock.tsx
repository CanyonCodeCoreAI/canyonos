import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

export const HEADER_DOCK_ID = 'app-header-dock';

/**
 * Renders header actions from inside a screen.
 *
 * `staticData.headerSlot` is the right tool when the action only needs route params, because it is
 * declarative and renders with the route. It cannot reach a screen's local state, so a screen whose
 * action depends on what the user has done there (an upload read, a field filled in) docks through
 * this portal instead — one button, owned where its state lives, rendered where the header keeps
 * every other primary action.
 *
 * The dock lives in the app shell above the route, so it is in the DOM by the time an effect runs but
 * not necessarily during a route component's first render — hence the node is held in state rather
 * than read inline.
 *
 * One occupant at a time: the dock has no arbitration, so at most one mounted component may dock per
 * screen. Two simultaneous occupants would both render, in mount order.
 */
export function HeaderDockPortal({ children }: { readonly children: ReactNode }) {
  const [dock, setDock] = useState<HTMLElement | null>(null);

  useEffect(() => setDock(document.getElementById(HEADER_DOCK_ID)), []);

  return dock ? createPortal(children, dock) : null;
}
