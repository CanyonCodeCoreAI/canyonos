// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** Valid usage events for the unit and end-to-end tests of the CLI usage API. */

import type { UsageEvent } from './usage.contract';

export const usageEvent = (overrides: Partial<UsageEvent> = {}): UsageEvent => ({
  event_id: crypto.randomUUID(),
  installation_id: '5b0c3f1e-8d2a-4c7b-9e1f-2a3b4c5d6e7f',
  command: 'deploy',
  succeeded: true,
  occurred_at: '2026-10-08T12:00:00.000Z',
  cli_version: '0.1.734',
  ...overrides,
});

export const usageEvents = (count: number): UsageEvent[] =>
  Array.from({ length: count }, () => usageEvent());
