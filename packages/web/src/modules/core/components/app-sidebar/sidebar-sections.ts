/**
 * Whether the sidebar offers the resources side of the app.
 *
 * Off for now: the demo leads with projects, and the resources overview plus its per-resource rows
 * pulled attention away from them. Nothing is deleted — `/resources`, its screens and the fleet
 * rollup all still work, and the sidebar entries come back by flipping this to `true`.
 *
 * The specs that cover those entries are skipped against this flag; search for this file's name to
 * find them.
 */
export const SHOW_RESOURCE_NAVIGATION = false;

/**
 * Whether the sidebar carries the overview links above the project list.
 *
 * Off for now. With resources hidden the switch had one destination left, and a lone "Projects
 * Overview" row above the project list restates where you already are. The workspace name in the
 * header still goes to /projects.
 */
export const SHOW_OVERVIEW_SWITCH = false;
