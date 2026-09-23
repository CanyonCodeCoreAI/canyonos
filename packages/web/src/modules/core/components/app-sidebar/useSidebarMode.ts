import { useRouterState } from '@tanstack/react-router';

export type SidebarMode = 'projects' | 'resources';

export function useSidebarMode(): SidebarMode {
  return useRouterState({
    select: (state) => {
      const { pathname } = state.location;
      return pathname === '/resources' || pathname.startsWith('/resources/')
        ? 'resources'
        : 'projects';
    },
  });
}
