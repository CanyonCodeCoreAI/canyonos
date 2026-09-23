import { Fragment } from 'react';
import type { ComponentProps } from 'react';

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarRail,
  SidebarSeparator,
} from '@repo/ui/shadcn/sidebar';
import { OverviewSwitch } from '@/modules/core/components/app-sidebar/OverviewSwitch';
import { ProjectNavigation } from '@/modules/core/components/app-sidebar/ProjectNavigation';
import { ResourceNavigation } from '@/modules/core/components/app-sidebar/ResourceNavigation';
import {
  SHOW_OVERVIEW_SWITCH,
  SHOW_RESOURCE_NAVIGATION,
} from '@/modules/core/components/app-sidebar/sidebar-sections';
import { UserMenu } from '@/modules/core/components/app-sidebar/UserMenu';
import { useSidebarMode } from '@/modules/core/components/app-sidebar/useSidebarMode';

export function AppSidebar(props: ComponentProps<typeof Sidebar>) {
  const mode = useSidebarMode();
  // With resources hidden there is only one section, so there is no order to swap and nothing to
  // animate between.
  const mode_animation = !SHOW_RESOURCE_NAVIGATION
    ? ''
    : mode === 'resources'
      ? 'animate-sidebar-mode-resources'
      : 'animate-sidebar-mode-projects';
  const sections = !SHOW_RESOURCE_NAVIGATION
    ? [<ProjectNavigation key="projects" />]
    : mode === 'resources'
      ? [<ResourceNavigation key="resources" />, <ProjectNavigation key="projects" />]
      : [<ProjectNavigation key="projects" />, <ResourceNavigation key="resources" />];

  return (
    <Sidebar collapsible="icon" data-testid="app-sidebar" {...props}>
      <SidebarContent className="gap-[0.1875rem] overflow-x-hidden overflow-y-auto px-3 py-[1.125rem] group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:px-2">
        {SHOW_OVERVIEW_SWITCH ? (
          <>
            <OverviewSwitch />
            <SidebarSeparator className="app-sidebar-hide-when-collapsed my-2.75" />
          </>
        ) : null}
        <div className={`${mode_animation} flex w-full flex-col gap-[0.1875rem]`}>
          {sections.map((section, index) => (
            <Fragment key={section.key}>
              {index > 0 ? (
                <SidebarSeparator className="app-sidebar-hide-when-collapsed my-2.75" />
              ) : null}
              {section}
            </Fragment>
          ))}
        </div>
      </SidebarContent>

      <SidebarFooter className="px-3 pt-0 pb-3 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:px-2">
        <UserMenu />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
