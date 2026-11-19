// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute } from '@tanstack/react-router';

import { rangeSelectionFromSearch } from '@/modules/core/time-range';
import { MonitoringSearchSchema } from '@/modules/monitoring/monitoring.search';
import { MonitoringScreen } from '@/modules/monitoring/screens/monitoring.screen';
import { WorkflowMonitoringBreadcrumbs } from '@/modules/workflows/components/workflow-breadcrumbs';

function MonitoringRoute() {
  const { workflow_id } = Route.useParams();
  const search = Route.useSearch();
  return (
    <MonitoringScreen
      workflow_id={workflow_id}
      range={rangeSelectionFromSearch(search)}
      view={search.view}
    />
  );
}

export const Route = createFileRoute('/_authenticated/workflows/$workflow_id/monitoring')({
  validateSearch: MonitoringSearchSchema,
  staticData: {
    breadcrumbSlot: WorkflowMonitoringBreadcrumbs,
  },
  component: MonitoringRoute,
});
