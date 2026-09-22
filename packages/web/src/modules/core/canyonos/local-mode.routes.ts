/**
 * The leaf routes CanyonOS local mode leaves open.
 *
 * A local install is one machine with no billing account, no import pipeline and no deploy target,
 * so every route that leads to one of those is closed rather than shown broken. The ids are the
 * exact `FileRoutesById` keys from the generated route tree; `local-mode.routes.test.ts` reads that
 * file and fails when a new route arrives undecided.
 *
 * Nothing here reads `webEnv`: that throws without a Vite env, which would put the app's whole
 * config behind a unit test that only needs the list.
 */
export const CANYONOS_LOCAL_ROUTE_IDS = [
  '/_brand/login',
  '/_brand/onboarding',
  '/_authenticated/',
  '/_authenticated/projects/',
  '/_authenticated/projects/$project_id/',
] as const;

const REACHABLE_ROUTE_IDS: ReadonlySet<string> = new Set(CANYONOS_LOCAL_ROUTE_IDS);

/**
 * Whether local mode serves this route.
 *
 * The id is optional because a URL that matches nothing resolves to an empty match chain, and an
 * unknown destination is closed for the same reason a known one is.
 */
export function isCanyonOsLocalRoute(route_id: string | undefined): boolean {
  return route_id !== undefined && REACHABLE_ROUTE_IDS.has(route_id);
}
