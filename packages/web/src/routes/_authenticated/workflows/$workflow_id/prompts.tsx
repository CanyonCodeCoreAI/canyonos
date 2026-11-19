// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute } from '@tanstack/react-router';

import { PromptsScreen } from '@/modules/prompts/prompts.screen';

export const Route = createFileRoute('/_authenticated/workflows/$workflow_id/prompts')({
  component: WorkflowPromptsRoute,
});

function WorkflowPromptsRoute() {
  const { workflow_id } = Route.useParams();
  return <PromptsScreen workflow_id={workflow_id} />;
}
