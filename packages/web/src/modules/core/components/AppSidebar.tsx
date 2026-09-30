import type { ComponentProps } from 'react';

import { Sidebar, SidebarContent, SidebarFooter, SidebarRail } from '@repo/ui/shadcn/sidebar';
import { ProjectNavigation } from '@/modules/core/components/app-sidebar/ProjectNavigation';
import { UserMenu } from '@/modules/core/components/app-sidebar/UserMenu';

export function AppSidebar(props: ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar collapsible="icon" data-testid="app-sidebar" {...props}>
      <SidebarContent className="gap-[0.1875rem] overflow-x-hidden overflow-y-auto px-3 py-[1.125rem] group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:px-2">
        <div className="flex w-full flex-col gap-[0.1875rem]">
          <ProjectNavigation />
        </div>
      </SidebarContent>

      <SidebarFooter className="px-3 pt-0 pb-3 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:px-2">
        <UserMenu />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
