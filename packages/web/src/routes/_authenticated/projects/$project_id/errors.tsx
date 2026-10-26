// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute } from '@tanstack/react-router';

import { rangeSelectionFromSearch } from '@/modules/core/time-range';
import { ErrorsScreen } from '@/modules/monitoring/screens/errors.screen';
import { ProjectErrorsBreadcrumbs } from '@/modules/projects/components/project-breadcrumbs';

function ErrorsRoute() {
  const { project_id } = Route.useParams();
  const range = rangeSelectionFromSearch(Route.useSearch());
  return <ErrorsScreen project_id={project_id} range={range} />;
}

export const Route = createFileRoute('/_authenticated/projects/$project_id/errors')({
  staticData: {
    breadcrumbSlot: ProjectErrorsBreadcrumbs,
  },
  component: ErrorsRoute,
});
