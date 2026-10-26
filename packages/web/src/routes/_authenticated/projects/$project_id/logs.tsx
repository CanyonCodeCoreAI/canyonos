// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute } from '@tanstack/react-router';

import { rangeSelectionFromSearch } from '@/modules/core/time-range';
import { LogsScreen } from '@/modules/monitoring/screens/logs.screen';
import { ProjectLogsBreadcrumbs } from '@/modules/projects/components/project-breadcrumbs';

function LogsRoute() {
  const { project_id } = Route.useParams();
  const range = rangeSelectionFromSearch(Route.useSearch());
  return <LogsScreen project_id={project_id} range={range} />;
}

export const Route = createFileRoute('/_authenticated/projects/$project_id/logs')({
  staticData: {
    breadcrumbSlot: ProjectLogsBreadcrumbs,
  },
  component: LogsRoute,
});
