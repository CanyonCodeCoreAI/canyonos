// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** The value `raw` holds as JSON, or undefined when it is absent or not JSON, so the caller's
 * schema decides what an unusable value means. */
export function parse_json(raw: string | null | undefined): unknown {
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
