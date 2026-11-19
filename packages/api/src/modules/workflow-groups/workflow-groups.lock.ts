// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

// One lock per workflow group, in this API process: it serializes what changes the group's upload
// and what acts on its deploy, on either target.

const locks = new Map<string, Promise<void>>();

/** Runs `work` holding the workflow group's lock, after whatever holds it now. */
export async function with_group_lock<T>(
  workflow_group_id: string,
  work: () => Promise<T>
): Promise<T> {
  const previous = locks.get(workflow_group_id) ?? Promise.resolve();
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  locks.set(workflow_group_id, released);
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}
