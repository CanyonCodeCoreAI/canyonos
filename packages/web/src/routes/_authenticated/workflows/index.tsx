// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute } from '@tanstack/react-router';

import { WorkflowsOverviewScreen } from '@/modules/workflows/screens/workflows-overview.screen';

// No breadcrumbSlot: the workspace link in the header already goes here, so a trail reading
// "Canyon Code | Workflows" would say the same thing twice. Deeper routes start at the workflow name.
export const Route = createFileRoute('/_authenticated/workflows/')({
  component: WorkflowsOverviewScreen,
});
