// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute } from '@tanstack/react-router';

import { rangeSelectionFromSearch } from '@/modules/core/time-range';
import { LogsScreen } from '@/modules/monitoring/screens/logs.screen';
import { WorkflowLogsBreadcrumbs } from '@/modules/workflows/components/workflow-breadcrumbs';

function LogsRoute() {
  const { workflow_id } = Route.useParams();
  const range = rangeSelectionFromSearch(Route.useSearch());
  return <LogsScreen workflow_id={workflow_id} range={range} />;
}

export const Route = createFileRoute('/_authenticated/workflows/$workflow_id/logs')({
  staticData: {
    breadcrumbSlot: WorkflowLogsBreadcrumbs,
  },
  component: LogsRoute,
});
