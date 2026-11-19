// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { getRouteApi } from '@tanstack/react-router';

import { BreadcrumbTrail } from '@/modules/core/components/BreadcrumbTrail';

const workflow_route = getRouteApi('/_authenticated/workflows/$workflow_id');

export function WorkflowBreadcrumbs() {
  const workflow = workflow_route.useLoaderData();
  return <BreadcrumbTrail segments={[{ id: 'workflow', label: workflow?.name ?? 'Workflow' }]} />;
}

export function WorkflowDeployBreadcrumbs() {
  const workflow = workflow_route.useLoaderData();
  return (
    <BreadcrumbTrail
      segments={[
        { id: 'workflow', label: workflow?.name ?? 'Workflow' },
        { id: 'deploy', label: 'Scaling Policy' },
      ]}
    />
  );
}

function WorkflowSectionBreadcrumbs({
  id,
  label,
}: {
  readonly id: string;
  readonly label: string;
}) {
  const workflow = workflow_route.useLoaderData();
  return (
    <BreadcrumbTrail
      segments={[
        { id: 'workflow', label: workflow?.name ?? 'Workflow' },
        { id, label },
      ]}
    />
  );
}

export function WorkflowMonitoringBreadcrumbs() {
  return <WorkflowSectionBreadcrumbs id="monitoring" label="Traces" />;
}

export function WorkflowLogsBreadcrumbs() {
  return <WorkflowSectionBreadcrumbs id="logs" label="Logs" />;
}

export function WorkflowErrorsBreadcrumbs() {
  return <WorkflowSectionBreadcrumbs id="errors" label="Errors" />;
}

export function WorkflowMetricsBreadcrumbs() {
  return <WorkflowSectionBreadcrumbs id="metrics" label="Metrics" />;
}

export function WorkflowDeploymentConfigBreadcrumbs() {
  const workflow = workflow_route.useLoaderData();
  return (
    <BreadcrumbTrail
      segments={[
        { id: 'workflow', label: workflow?.name ?? 'Workflow' },
        { id: 'deployment-config', label: 'Deployment Config' },
      ]}
    />
  );
}

export function WorkflowDeployPerformanceBreadcrumbs() {
  const workflow = workflow_route.useLoaderData();
  return (
    <BreadcrumbTrail
      segments={[
        { id: 'workflow', label: workflow?.name ?? 'Workflow' },
        { id: 'deploy', label: 'Scaling Policy' },
        { id: 'performance', label: 'Emulate' },
      ]}
    />
  );
}

export function WorkflowImportBreadcrumbs() {
  return <BreadcrumbTrail segments={[{ id: 'import', label: 'Import' }]} />;
}
