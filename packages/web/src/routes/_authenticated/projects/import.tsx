import { createFileRoute } from '@tanstack/react-router';

import { ProjectImportBreadcrumbs } from '@/modules/projects/components/project-breadcrumbs';
import { ProjectImportScreen } from '@/modules/projects/screens/project-import.screen';

export const Route = createFileRoute('/_authenticated/projects/import')({
  staticData: { breadcrumbSlot: ProjectImportBreadcrumbs },
  component: ProjectImportScreen,
});
