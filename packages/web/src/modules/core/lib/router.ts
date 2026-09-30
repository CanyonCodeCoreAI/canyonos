import { QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';
import type { BrandCopy } from '@/modules/auth/components/CanyonBrandPanel';

export const queryClient = new QueryClient();

export const router = createRouter({ routeTree, context: { queryClient } });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }

  interface StaticDataRouteOption {
    brand?: BrandCopy;
  }
}
