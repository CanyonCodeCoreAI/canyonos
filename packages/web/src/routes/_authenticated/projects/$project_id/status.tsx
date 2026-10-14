// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute } from '@tanstack/react-router';

import { StatusScreen } from '@/modules/monitoring/screens/status.screen';

export const Route = createFileRoute('/_authenticated/projects/$project_id/status')({
  component: StatusRoute,
});

function StatusRoute() {
  const { project_id } = Route.useParams();
  return <StatusScreen project_id={project_id} />;
}
