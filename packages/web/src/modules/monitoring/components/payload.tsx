// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

export function Payload({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="mb-3">
      <div className="text-muted-foreground mb-1">{label}</div>
      <pre className="text-foreground break-words whitespace-pre-wrap">{value}</pre>
    </div>
  );
}
