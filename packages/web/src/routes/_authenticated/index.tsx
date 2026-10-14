// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute, redirect } from '@tanstack/react-router';

// The authenticated home is the Projects Overview, which lives at /projects.
export const Route = createFileRoute('/_authenticated/')({
  beforeLoad: () => {
    throw redirect({ to: '/projects' });
  },
});
