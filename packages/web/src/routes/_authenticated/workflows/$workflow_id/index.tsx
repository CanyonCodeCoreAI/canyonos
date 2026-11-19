// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute } from '@tanstack/react-router';

import { rangeSelectionFromSearch } from '@/modules/core/time-range';
import { WorkflowScreen } from '@/modules/workflows/screens/workflow.screen';

export const Route = createFileRoute('/_authenticated/workflows/$workflow_id/')({
  component: WorkflowRoute,
});

function WorkflowRoute() {
  const { workflow_id } = Route.useParams();
  const range = rangeSelectionFromSearch(Route.useSearch());
  return <WorkflowScreen workflow_id={workflow_id} range={range} />;
}
