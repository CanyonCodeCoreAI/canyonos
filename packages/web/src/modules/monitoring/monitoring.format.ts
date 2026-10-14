// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

export const formatTokens = (value: number | null) =>
  value === null ? '—' : value.toLocaleString();

export const formatCost = (value: number | null) => (value === null ? '—' : `$${value.toFixed(4)}`);
