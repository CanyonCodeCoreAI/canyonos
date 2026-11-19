// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute } from '@tanstack/react-router';

import { rangeSelectionFromSearch } from '@/modules/core/time-range';
import { MetricsScreen } from '@/modules/monitoring/screens/metrics.screen';
import { WorkflowMetricsBreadcrumbs } from '@/modules/workflows/components/workflow-breadcrumbs';

function MetricsRoute() {
  const { workflow_id } = Route.useParams();
  const range = rangeSelectionFromSearch(Route.useSearch());
  return <MetricsScreen workflow_id={workflow_id} range={range} />;
}

export const Route = createFileRoute('/_authenticated/workflows/$workflow_id/metrics')({
  staticData: {
    breadcrumbSlot: WorkflowMetricsBreadcrumbs,
  },
  component: MetricsRoute,
});
