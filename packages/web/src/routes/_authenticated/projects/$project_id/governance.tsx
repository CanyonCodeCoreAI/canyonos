// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { GovernanceScreen } from '@/modules/governance/governance.screen';

// `catch` lands a stale or hand-edited link on the canvas instead of the route error screen.
const GovernanceSearchSchema = z.object({
  agent: z.string().min(1).optional().catch(undefined),
  panel: z.literal('policy').optional().catch(undefined),
});

export const Route = createFileRoute('/_authenticated/projects/$project_id/governance')({
  validateSearch: GovernanceSearchSchema,
  component: GovernanceRoute,
});

function GovernanceRoute() {
  const { project_id } = Route.useParams();
  const { agent, panel } = Route.useSearch();
  return <GovernanceScreen project_id={project_id} agent={agent} panel={panel} />;
}
