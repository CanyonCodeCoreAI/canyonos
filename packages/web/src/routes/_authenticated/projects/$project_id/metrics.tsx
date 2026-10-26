// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute } from '@tanstack/react-router';

import { rangeSelectionFromSearch } from '@/modules/core/time-range';
import { MetricsScreen } from '@/modules/monitoring/screens/metrics.screen';
import { ProjectMetricsBreadcrumbs } from '@/modules/projects/components/project-breadcrumbs';

function MetricsRoute() {
  const { project_id } = Route.useParams();
  const range = rangeSelectionFromSearch(Route.useSearch());
  return <MetricsScreen project_id={project_id} range={range} />;
}

export const Route = createFileRoute('/_authenticated/projects/$project_id/metrics')({
  staticData: {
    breadcrumbSlot: ProjectMetricsBreadcrumbs,
  },
  component: MetricsRoute,
});
