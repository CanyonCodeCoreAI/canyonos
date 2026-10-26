// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute } from '@tanstack/react-router';

import { rangeSelectionFromSearch } from '@/modules/core/time-range';
import { MonitoringSearchSchema } from '@/modules/monitoring/monitoring.search';
import { MonitoringScreen } from '@/modules/monitoring/screens/monitoring.screen';
import { ProjectMonitoringBreadcrumbs } from '@/modules/projects/components/project-breadcrumbs';

function MonitoringRoute() {
  const { project_id } = Route.useParams();
  const search = Route.useSearch();
  return (
    <MonitoringScreen
      project_id={project_id}
      range={rangeSelectionFromSearch(search)}
      view={search.view}
    />
  );
}

export const Route = createFileRoute('/_authenticated/projects/$project_id/monitoring')({
  validateSearch: MonitoringSearchSchema,
  staticData: {
    breadcrumbSlot: ProjectMonitoringBreadcrumbs,
  },
  component: MonitoringRoute,
});
