import { Link } from '@tanstack/react-router';

import { Separator } from '@repo/ui/shadcn/separator';
import { SidebarTrigger } from '@repo/ui/shadcn/sidebar';
import { HEADER_DOCK_ID } from '@/modules/core/navigation/header-dock';
import { useBreadcrumbSlot, useHeaderSlot } from '@/modules/core/navigation/header-slot';

export function AppHeader({ workspace }: { workspace: string }) {
  const BreadcrumbSlot = useBreadcrumbSlot();
  const HeaderSlot = useHeaderSlot();

  return (
    <header
      data-testid="app-header"
      className="bg-background flex h-(--header-height) shrink-0 items-center gap-3 border-b px-4"
    >
      <SidebarTrigger className="-ml-1" />

      <div className="flex min-w-0 items-center gap-3">
        <Link
          to="/projects"
          data-testid="app-header-workspace-link"
          className="text-foreground text-base font-bold tracking-tight"
        >
          {workspace}
        </Link>
        {BreadcrumbSlot ? (
          <>
            <Separator orientation="vertical" className="h-4!" />
            <BreadcrumbSlot />
          </>
        ) : null}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <div
          id={HEADER_DOCK_ID}
          className="flex items-center gap-2 empty:hidden"
          data-testid="app-header-dock"
        />
        {HeaderSlot ? (
          <div className="flex items-center gap-2" data-testid="app-header-slot">
            <HeaderSlot />
          </div>
        ) : null}
      </div>
    </header>
  );
}
