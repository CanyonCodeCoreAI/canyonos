// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute } from '@tanstack/react-router';

import { rangeSelectionFromSearch } from '@/modules/core/time-range';
import { ErrorsScreen } from '@/modules/monitoring/screens/errors.screen';
import { WorkflowErrorsBreadcrumbs } from '@/modules/workflows/components/workflow-breadcrumbs';

function ErrorsRoute() {
  const { workflow_id } = Route.useParams();
  const range = rangeSelectionFromSearch(Route.useSearch());
  return <ErrorsScreen workflow_id={workflow_id} range={range} />;
}

export const Route = createFileRoute('/_authenticated/workflows/$workflow_id/errors')({
  staticData: {
    breadcrumbSlot: WorkflowErrorsBreadcrumbs,
  },
  component: ErrorsRoute,
});
