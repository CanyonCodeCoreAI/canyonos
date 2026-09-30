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

function ProjectSectionBreadcrumbs({ id, label }: { readonly id: string; readonly label: string }) {
  const project = project_route.useLoaderData();
  return (
    <BreadcrumbTrail
      segments={[
        { id: 'project', label: project?.name ?? 'Project' },
        { id, label },
      ]}
    />
  );
}

export function ProjectMonitoringBreadcrumbs() {
  return <ProjectSectionBreadcrumbs id="monitoring" label="Traces" />;
}

export function ProjectLogsBreadcrumbs() {
  return <ProjectSectionBreadcrumbs id="logs" label="Logs" />;
}

export function ProjectErrorsBreadcrumbs() {
  return <ProjectSectionBreadcrumbs id="errors" label="Errors" />;
}

export function ProjectMetricsBreadcrumbs() {
  return <ProjectSectionBreadcrumbs id="metrics" label="Metrics" />;
}

export function ProjectLlmBreadcrumbs() {
  return <ProjectSectionBreadcrumbs id="llm" label="LLM" />;
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
