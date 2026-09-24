import { createFileRoute } from '@tanstack/react-router';

import { CreateProjectHeaderSlot } from '@/modules/projects/components/project-header-slots';
import { ResourcesOverviewBreadcrumbs } from '@/modules/resources/components/ResourceBreadcrumbs';
import { ResourceOverviewScreen } from '@/modules/resources/screens/overview.screen';

export const Route = createFileRoute('/_authenticated/resources/')({
  staticData: {
    breadcrumbSlot: ResourcesOverviewBreadcrumbs,
    headerSlot: CreateProjectHeaderSlot,
  },
  component: ResourceOverviewScreen,
});
