import { describe, expect, test } from 'bun:test';

import { CANYONOS_LOCAL_ROUTE_IDS, isCanyonOsLocalRoute } from './local-mode.routes';

const ROUTE_TREE = new URL('../../../routeTree.gen.ts', import.meta.url);

/**
 * Every route id the router knows, read out of the generated tree as text.
 *
 * Read rather than imported on purpose. Importing `routeTree.gen.ts` pulls in every screen, and
 * those reach `webEnv`, which throws without a Vite env. Reading it also keeps this the single
 * source of route ids: a route added to the app arrives here as a failing test rather than as a
 * surface that quietly opened or closed.
 */
async function allRouteIds(): Promise<string[]> {
  const source = await Bun.file(ROUTE_TREE).text();
  const block = /export interface FileRoutesById \{\n([\s\S]*?)\n\}/.exec(source);
  if (!block?.[1]) throw new Error('No FileRoutesById block in routeTree.gen.ts');

  const ids = [...block[1].matchAll(/^\s*(?:'([^']+)'|(\w+))\s*:/gm)].map(
    (match) => match[1] ?? match[2]
  );
  if (ids.length === 0) throw new Error('No route ids in the FileRoutesById block');
  return ids as string[];
}

describe('CanyonOS local mode routes', () => {
  test('every route it opens is a route the app has', async () => {
    const ids = await allRouteIds();

    for (const id of CANYONOS_LOCAL_ROUTE_IDS) {
      expect(ids).toContain(id);
    }
  });

  test('every other route the app has is closed', async () => {
    const ids = await allRouteIds();
    const open: string[] = CANYONOS_LOCAL_ROUTE_IDS.slice();

    for (const id of ids) {
      expect({ id, open: isCanyonOsLocalRoute(id) }).toEqual({ id, open: open.includes(id) });
    }
  });

  test('the layout route above a project is closed, so only its index is reachable', async () => {
    const ids = await allRouteIds();

    expect(ids).toContain('/_authenticated/projects/$project_id');
    expect(isCanyonOsLocalRoute('/_authenticated/projects/$project_id')).toBe(false);
    expect(isCanyonOsLocalRoute('/_authenticated/projects/$project_id/')).toBe(true);
  });

  test('a URL that matches no route is closed', () => {
    expect(isCanyonOsLocalRoute(undefined)).toBe(false);
  });
});
