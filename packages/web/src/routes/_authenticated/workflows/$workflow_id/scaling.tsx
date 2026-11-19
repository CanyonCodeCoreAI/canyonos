// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute } from '@tanstack/react-router';

import { ScalingScreen } from '@/modules/scaling/scaling.screen';

export const Route = createFileRoute('/_authenticated/workflows/$workflow_id/scaling')({
  component: ScalingRoute,
});

function ScalingRoute() {
  const { workflow_id } = Route.useParams();
  return <ScalingScreen workflow_id={workflow_id} />;
}
