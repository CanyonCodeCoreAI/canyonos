import { createFileRoute } from '@tanstack/react-router';

import { ProjectsOverviewScreen } from '@/modules/projects/screens/projects-overview.screen';

// No breadcrumbSlot: the workspace link in the header already goes here, so a trail reading
// "Canyon Code | Projects" would say the same thing twice. Deeper routes start at the project name.
export const Route = createFileRoute('/_authenticated/projects/')({
  component: ProjectsOverviewScreen,
});
