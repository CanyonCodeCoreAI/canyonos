import { getRouteApi } from '@tanstack/react-router';

import { BreadcrumbTrail } from '@/modules/core/components/BreadcrumbTrail';

const project_route = getRouteApi('/_authenticated/projects/$project_id');

export function ProjectBreadcrumbs() {
  const project = project_route.useLoaderData();
  return <BreadcrumbTrail segments={[{ id: 'project', label: project?.name ?? 'Project' }]} />;
}

export function ProjectDeployBreadcrumbs() {
  const project = project_route.useLoaderData();
  return (
    <BreadcrumbTrail
      segments={[
        { id: 'project', label: project?.name ?? 'Project' },
        { id: 'deploy', label: 'Scaling Policy' },
      ]}
    />
  );
}

export function ProjectDeploymentConfigBreadcrumbs() {
  const project = project_route.useLoaderData();
  return (
    <BreadcrumbTrail
      segments={[
        { id: 'project', label: project?.name ?? 'Project' },
        { id: 'deployment-config', label: 'Deployment Config' },
      ]}
    />
  );
}

export function ProjectDeployPerformanceBreadcrumbs() {
  const project = project_route.useLoaderData();
  return (
    <BreadcrumbTrail
      segments={[
        { id: 'project', label: project?.name ?? 'Project' },
        { id: 'deploy', label: 'Scaling Policy' },
        { id: 'performance', label: 'Emulate' },
      ]}
    />
  );
}

export function ProjectWorkflowDesignBreadcrumbs() {
  const project = project_route.useLoaderData();
  return (
    <BreadcrumbTrail
      segments={[
        { id: 'project', label: project?.name ?? 'Project' },
        { id: 'workflows', label: 'Workflows' },
        { id: 'design', label: 'Design' },
      ]}
    />
  );
}

export function ProjectImportBreadcrumbs() {
  return <BreadcrumbTrail segments={[{ id: 'import', label: 'Import' }]} />;
}
