import { createFileRoute } from '@tanstack/react-router';

import { CreateProjectHeaderSlot } from '@/modules/projects/components/project-header-slots';
import { ResourceBreadcrumbs } from '@/modules/resources/components/ResourceBreadcrumbs';
import { ResourceScreen } from '@/modules/resources/screens/resource.screen';

export const Route = createFileRoute('/_authenticated/resources/$resource')({
  staticData: {
    breadcrumbSlot: ResourceBreadcrumbs,
    headerSlot: CreateProjectHeaderSlot,
  },
  component: ResourceScreen,
});
