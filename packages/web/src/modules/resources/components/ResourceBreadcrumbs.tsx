import { getRouteApi } from '@tanstack/react-router';

import { BreadcrumbTrail } from '@/modules/core/components/BreadcrumbTrail';
import { resources } from '@/modules/core/navigation/navigation';

const resource_route = getRouteApi('/_authenticated/resources/$resource');

function resourceLabel(id: string): string {
  return resources.find((resource) => resource.id === id)?.name ?? id.toUpperCase();
}

export function ResourcesOverviewBreadcrumbs() {
  return <BreadcrumbTrail segments={[{ id: 'resources', label: 'Resources' }]} />;
}

export function ResourceBreadcrumbs() {
  const { resource } = resource_route.useParams();
  return (
    <BreadcrumbTrail
      segments={[
        { id: 'resources', label: 'Resources' },
        { id: 'resource', label: resourceLabel(resource) },
      ]}
    />
  );
}
