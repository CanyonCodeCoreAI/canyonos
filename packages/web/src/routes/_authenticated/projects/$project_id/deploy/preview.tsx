import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowLeftIcon } from 'lucide-react';

import { Button } from '@repo/ui/shadcn/button';
import { DeployPreviewScreen } from '@/modules/deploy/screens/deploy-preview.screen';
import { ProjectDeployBreadcrumbs } from '@/modules/projects/components/project-breadcrumbs';

function DeployPreviewRoute() {
  const { project_id } = Route.useParams();
  return <DeployPreviewScreen project_id={project_id} />;
}

function DeployPreviewHeaderSlot() {
  const { project_id } = Route.useParams();
  return (
    <Button asChild variant="outline" size="sm">
      <Link
        to="/projects/$project_id/deploy"
        params={{ project_id }}
        data-testid="header-back-to-deploy-config"
      >
        <ArrowLeftIcon aria-hidden />
        Back to deploy config
      </Link>
    </Button>
  );
}

export const Route = createFileRoute('/_authenticated/projects/$project_id/deploy/preview')({
  staticData: {
    breadcrumbSlot: ProjectDeployBreadcrumbs,
    headerSlot: DeployPreviewHeaderSlot,
  },
  component: DeployPreviewRoute,
});
