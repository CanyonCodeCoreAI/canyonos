import { useMatches } from '@tanstack/react-router';
import type { CSSProperties, ReactNode } from 'react';

import { SidebarInset, SidebarProvider } from '@repo/ui/shadcn/sidebar';
import { cn } from '@repo/ui/utils';
import { AppHeader } from '@/modules/core/components/AppHeader';
import { AppSidebar } from '@/modules/core/components/AppSidebar';

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    contentWidth?: ContentWidth;
  }
}

type ContentWidth = 'default' | 'wide';

const WORKSPACE_NAME = 'Canyon Code';

const CONTENT_WIDTH_CLASS: Record<ContentWidth, string> = {
  default: 'max-w-[90.625rem]',
  wide: 'max-w-[115rem]',
};

function useContentWidth(): ContentWidth {
  const matches = useMatches();
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const width = matches[index]?.staticData.contentWidth;
    if (width) return width;
  }
  return 'default';
}

export function AppLayout({ children }: { children: ReactNode }) {
  const content_width = useContentWidth();

  return (
    <SidebarProvider
      className="h-svh flex-col overflow-hidden"
      style={{ '--header-height': '3.75rem', '--sidebar-width': '17.625rem' } as CSSProperties}
    >
      <AppHeader workspace={WORKSPACE_NAME} />
      <div className="flex min-h-0 w-full flex-1">
        <AppSidebar />
        <SidebarInset
          data-testid="app-content-scroll"
          className="scroll-area min-h-0 overflow-y-auto"
        >
          <div
            className={cn(
              'mx-auto flex min-h-0 w-full flex-1 flex-col',
              CONTENT_WIDTH_CLASS[content_width]
            )}
          >
            {children}
          </div>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
