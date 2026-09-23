import { Link } from '@tanstack/react-router';
import { LayoutDashboardIcon, LayoutGridIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { SHOW_RESOURCE_NAVIGATION } from '@/modules/core/components/app-sidebar/sidebar-sections';

interface OverviewOption {
  readonly label: string;
  readonly to: '/projects' | '/resources';
  readonly icon: LucideIcon;
  readonly testId: string;
}

const PROJECTS_OPTION: OverviewOption = {
  label: 'Projects Overview',
  to: '/projects',
  icon: LayoutGridIcon,
  testId: 'nav-projects-overview',
};

const RESOURCES_OPTION: OverviewOption = {
  label: 'Resources Overview',
  to: '/resources',
  icon: LayoutDashboardIcon,
  testId: 'nav-resources-overview',
};

const OVERVIEW_OPTIONS: readonly OverviewOption[] = SHOW_RESOURCE_NAVIGATION
  ? [PROJECTS_OPTION, RESOURCES_OPTION]
  : [PROJECTS_OPTION];

export function OverviewSwitch() {
  return (
    <div className="flex flex-col gap-[0.1875rem]">
      {OVERVIEW_OPTIONS.map((option) => {
        const Icon = option.icon;

        return (
          <Link
            key={option.to}
            to={option.to}
            activeOptions={{ exact: true }}
            activeProps={{ className: 'bg-background shadow-xs' }}
            data-testid={option.testId}
            title={option.label}
            className="app-sidebar-row app-sidebar-collapse-to-icon focus-visible:ring-ring ease-snappy gap-[0.625rem] px-[0.6875rem] py-[0.5625rem] transition-[color,background-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:outline-none"
          >
            <Icon
              className="text-foreground size-[0.9375rem] shrink-0"
              strokeWidth={2}
              aria-hidden
            />
            <span className="app-sidebar-hide-when-collapsed text-foreground flex-1 text-[0.84375rem] font-semibold whitespace-nowrap">
              {option.label}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
