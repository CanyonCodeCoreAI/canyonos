// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { DeployedFingerprints, StoredLastApply } from '@api/db/schema';
import { LOG_DOMAINS, logger } from '@core/logger';

import { with_group_lock } from './workflow-groups.lock';
import { workflow_groups_repo } from './workflow-groups.repo';
import { target } from './workflow-groups.target';
import type { WorkflowGroupRow } from './workflow-groups.repo';
import type { ApplyFailure } from './workflow-groups.target';
import type { ApplyAction, ApplyFailureCode, Fingerprints } from './workflow-groups.types';

// The apply loop: once a workflow group's upload stops changing, start, restart, reload or stop
// its deploy to match it on this API's target (workflow-groups.target.ts), and record the
// outcome.

const apply_logger = logger.child({ domain: LOG_DOMAINS.WORKFLOW_GROUPS });

// How long the upload must stay unchanged before the apply loop acts on it.
const SETTLE_MS = 2_000;
// How often a deploy that is still starting is looked at again.
const STARTING_POLL_MS = 1_000;
const RETRY_MS = 5_000;
const WORKFLOW_GROUP_CONFIG = 'workflow_group.yaml';
const ENV_FILE = '.env';

/** What this API holds in memory per workflow group. */
interface GroupState {
  /** Upload PUTs in progress, counted from before their body is read. */
  uploads: number;
  applying: Exclude<ApplyAction, 'none'> | null;
  /** A change came that the loop has not looked at yet. */
  pending: boolean;
  looping: boolean;
  /** Woken on each change, finished upload and applied pass. */
  waiters: Set<() => void>;
}

const groups = new Map<string, GroupState>();

function group(workflow_group_id: string): GroupState {
  let state = groups.get(workflow_group_id);
  if (!state) {
    state = {
      uploads: 0,
      applying: null,
      pending: false,
      looping: false,
      waiters: new Set(),
    };
    groups.set(workflow_group_id, state);
  }
  return state;
}

function notify(workflow_group_id: string): void {
  const { waiters } = group(workflow_group_id);
  for (const wake of waiters) wake();
  waiters.clear();
}

/** Resolves on the workflow group's next change, or after `ms`. */
function changed(workflow_group_id: string, ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, Math.max(ms, 0));
  group(workflow_group_id).waiters.add(resolve);
  return promise.finally(() => clearTimeout(timer));
}

/** Counts an upload PUT as in progress; the apply loop waits until none is. Returns the
 * function that stops counting it, which does so once however often it is called. */
export function upload_started(workflow_group_id: string): () => void {
  const state = group(workflow_group_id);
  state.uploads += 1;
  let counted = true;
  return () => {
    if (!counted) return;
    counted = false;
    state.uploads -= 1;
    notify(workflow_group_id);
  };
}

export function applying(workflow_group_id: string): GroupState['applying'] {
  return groups.get(workflow_group_id)?.applying ?? null;
}

/** Wakes the workflow group's apply loop, starting it when it is not running. */
export function record_change(workflow_group_id: string): void {
  const state = group(workflow_group_id);
  state.pending = true;
  notify(workflow_group_id);
  if (state.looping) return;
  state.looping = true;
  void (async () => {
    try {
      while (state.pending) {
        state.pending = false;
        try {
          await apply_unapplied(workflow_group_id);
        } catch (error) {
          apply_logger.warn('The apply loop failed; it tries again', {
            workflow_group_id,
            error,
          });
          state.pending = true;
          await changed(workflow_group_id, RETRY_MS);
        }
      }
    } finally {
      state.looping = false;
    }
  })();
}

/** Waits until the apply loop has applied `generation`; returns the outcome, or null when the
 * workflow group's row is gone. */
export async function applied(
  workflow_group_id: string,
  generation: number
): Promise<StoredLastApply | null> {
  for (;;) {
    const row = await workflow_groups_repo.find(workflow_group_id);
    if (!row) return null;
    if (row.applied_generation >= generation && row.last_apply) return row.last_apply;
    await changed(workflow_group_id, STARTING_POLL_MS);
  }
}

/** Starts the apply loop of each workflow group whose last change was not applied, as before
 * this API restarted, once the target rebuilt what it keeps in memory. A target that rebuilds
 * its deploys from where they run (Kubernetes) resumes none: its restored rows hold no
 * workflows, and a loop would stop every deploy until the next upload. */
export async function resume_apply_loops(): Promise<void> {
  await target.restore();
  if (!target.resumes_apply_loops) return;
  for (const workflow_group_id of await workflow_groups_repo.list_unapplied()) {
    record_change(workflow_group_id);
  }
}

const sha256 = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex');

const by_code_point = ([a]: [string, string], [b]: [string, string]) =>
  a < b ? -1 : a > b ? 1 : 0;

/** SHA-256 digests over the files in `digests`: `config` for workflow_group.yaml, the `.env`
 * files and each workflow's `config/` files, which a reload applies, and `code` for the rest,
 * which needs a restart (canyonos_core/workspace_upload.py `fingerprints`). */
export function fingerprints(digests: Record<string, string>): Fingerprints {
  const parts = { code: new Bun.CryptoHasher('sha256'), config: new Bun.CryptoHasher('sha256') };
  for (const [path, digest] of Object.entries(digests).sort(by_code_point)) {
    const segments = path.split('/');
    const is_config =
      path === WORKFLOW_GROUP_CONFIG || segments.at(-1) === ENV_FILE || segments[1] === 'config';
    parts[is_config ? 'config' : 'code'].update(`${path}\0${digest}\0`);
  }
  return { code: parts.code.digest('hex'), config: parts.config.digest('hex') };
}

export const env_digest = (env: string | null) => (env === null ? null : sha256(env));

/** Whether the upload can be deployed: workflow_group.yaml and at least one workflow. */
const is_ready = (row: WorkflowGroupRow) =>
  row.config !== null && Object.keys(row.workflows).length > 0;

/** The fingerprints the uploaded files have, and the API key hash its endpoint checks. */
function uploaded_fingerprints(row: WorkflowGroupRow): DeployedFingerprints {
  const digests: Record<string, string> = {};
  if (row.config !== null) digests[WORKFLOW_GROUP_CONFIG] = sha256(row.config);
  if (row.env_digest !== null) digests[ENV_FILE] = row.env_digest;
  for (const workflow of Object.values(row.workflows)) Object.assign(digests, workflow.digests);
  return {
    ...fingerprints(digests),
    auth: row.api_key_hash ? { apiKeyHash: row.api_key_hash } : {},
  };
}

const same_auth = (a: DeployedFingerprints['auth'], b: DeployedFingerprints['auth']) =>
  (a.apiKeyHash ?? null) === (b.apiKeyHash ?? null);

function choose_action(
  ready: boolean,
  running: boolean,
  uploaded: DeployedFingerprints,
  deployed: DeployedFingerprints | null
): ApplyAction {
  if (!ready) return running ? 'stop' : 'none';
  if (!running) return 'start';
  if (!deployed || uploaded.code !== deployed.code || !same_auth(uploaded.auth, deployed.auth)) {
    return 'restart';
  }
  return uploaded.config !== deployed.config ? 'reload' : 'none';
}

const message_of = (error: unknown) => (error instanceof Error ? error.message : String(error));

// The code of an action that failed with an error of its own; `none` does nothing to fail.
const FAILURE_OF_ACTION: Record<ApplyAction, ApplyFailureCode> = {
  none: 'start_failed',
  start: 'start_failed',
  restart: 'stop_failed',
  stop: 'stop_failed',
  reload: 'reload_failed',
};

/** Brings the deploy in line with the upload once, holding the workflow group's lock. */
async function apply_once(workflow_group_id: string): Promise<void> {
  await with_group_lock(workflow_group_id, async () => {
    const found = await workflow_groups_repo.find(workflow_group_id);
    if (!found) return;
    const pass = await target.begin_apply(found);
    const { row } = pass;
    const { generation } = row;
    const uploaded = uploaded_fingerprints(row);
    const action = choose_action(is_ready(row), pass.running, uploaded, row.deployed);
    const state = group(workflow_group_id);
    state.applying = action === 'none' ? null : action;
    let failure: ApplyFailure | null = null;
    try {
      if (action === 'stop' || action === 'restart') failure = await pass.stop();
      if (action === 'start' || (action === 'restart' && !failure)) {
        failure = await pass.start(uploaded);
      } else if (action === 'reload') {
        failure = await pass.reload(uploaded);
      }
    } catch (error) {
      apply_logger.error('Applying the upload failed', { workflow_group_id, action, error });
      failure = { error: message_of(error), code: FAILURE_OF_ACTION[action] };
    } finally {
      state.applying = null;
    }
    await workflow_groups_repo.save_apply(workflow_group_id, {
      generation,
      action,
      ok: !failure,
      error: failure?.error ?? null,
      code: failure?.code ?? null,
    });
    apply_logger.info('Applied the upload', { workflow_group_id, generation, action, failure });
  });
  notify(workflow_group_id);
}

/** Applies the workflow group's changes until its latest generation is applied. */
async function apply_unapplied(workflow_group_id: string): Promise<void> {
  const state = group(workflow_group_id);
  for (;;) {
    let row = await workflow_groups_repo.find(workflow_group_id);
    if (!row || row.generation <= row.applied_generation) return;
    // Settle: no upload in progress, and none finished within the last two seconds.
    for (;;) {
      const quiet_at = row.last_change_at.getTime() + SETTLE_MS;
      if (state.uploads === 0 && Date.now() >= quiet_at) break;
      await changed(workflow_group_id, state.uploads > 0 ? SETTLE_MS : quiet_at - Date.now());
      row = await workflow_groups_repo.find(workflow_group_id);
      if (!row) return;
    }
    // A stop goes ahead; anything else waits for the deploy to finish starting, looked at each
    // second, so a DELETE that comes meanwhile stops it right away.
    for (;;) {
      if (!is_ready(row)) break;
      if (!(await target.starting(workflow_group_id))) break;
      await changed(workflow_group_id, STARTING_POLL_MS);
      row = await workflow_groups_repo.find(workflow_group_id);
      if (!row) return;
    }
    await apply_once(workflow_group_id);
  }
}
