// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

import type { DeployedFingerprints, StoredLastApply } from '@api/db/schema';
import * as docker from '@core/docker';
import { config } from '@core/env';
import { LOG_DOMAINS, logger } from '@core/logger';
import type { Container } from '@core/docker';

import {
  core_answer,
  core_error,
  find_controller,
  read_progress,
  run_in_controller,
  signal,
  stop_controller,
} from './workflow-groups.controller';
import { workflow_groups_repo } from './workflow-groups.repo';
import type { WorkflowGroupRow } from './workflow-groups.repo';
import type { ApplyAction, ApplyFailureCode, Fingerprints } from './workflow-groups.types';

// The apply loop: once a workflow group's upload stops changing, start, restart, reload or stop
// its Global Controller container to match it, and record the outcome, as the Global
// Controller server did on Docker (canyonos_api_interface/api_interface.py `_apply_changes`).

const apply_logger = logger.child({ domain: LOG_DOMAINS.WORKFLOW_GROUPS });

// How long the upload must stay unchanged before the apply loop acts on it.
const SETTLE_MS = 2_000;
// How often a deploy that is still starting is looked at again.
const STARTING_POLL_MS = 1_000;
const RELOAD_TIMEOUT_SECONDS = 60;
const RELOAD_POLL_MS = 500;
const RETRY_MS = 5_000;
const EXPLAINED_FAILURE_EXIT_CODE = 1;
const WORKFLOW_GROUP_CONFIG = 'workflow_group.yaml';
const ENV_FILE = '.env';

const CheckedSchema = z.object({ ok: z.literal(true) });

interface Failure {
  error: string;
  code: ApplyFailureCode;
}

/** What this API holds in memory per workflow group. */
interface GroupState {
  /** Serializes the jobs that change its /workspace and the actions on its container. */
  lock: Promise<void>;
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
      lock: Promise.resolve(),
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

/** Runs `work` holding the workflow group's lock, after whatever holds it now. */
export async function with_group_lock<T>(
  workflow_group_id: string,
  work: () => Promise<T>
): Promise<T> {
  const state = group(workflow_group_id);
  const previous = state.lock;
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  state.lock = released;
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
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
 * this API restarted. */
export async function resume_apply_loops(): Promise<void> {
  if (config.docker.socket === null) return;
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

/** Starts the container, having recorded what it runs first. */
async function start(
  row: WorkflowGroupRow,
  controller: Container | null,
  uploaded: DeployedFingerprints
): Promise<Failure | null> {
  if (!controller) {
    return {
      error: 'No Global Controller container to start: run `canyonos deploy` to create it',
      code: 'start_failed',
    };
  }
  await workflow_groups_repo.save_deployed(row.id, uploaded, controller.id);
  try {
    await docker.start(controller.id);
  } catch (error) {
    return {
      error: `Could not start the Global Controller: ${message_of(error)}`,
      code: 'start_failed',
    };
  }
  apply_logger.info('Global Controller started', { workflow_group_id: row.id });
  return null;
}

/** Has the running deploy reload the config in /workspace, without restarting the agents that
 * stay, and waits for its answer in the progress file. */
async function reload(
  row: WorkflowGroupRow,
  controller: Container,
  uploaded: DeployedFingerprints
): Promise<Failure | null> {
  const reply = await run_in_controller(controller, ['check']);
  const violations = core_error(reply, EXPLAINED_FAILURE_EXIT_CODE);
  if (violations !== null) return { error: violations, code: 'config_invalid' };
  core_answer(reply, CheckedSchema);
  const asked_seq = (await read_progress(controller)).reload?.seq ?? 0;
  const stopped: Failure = { error: 'The deploy stopped while reloading.', code: 'reload_failed' };
  if (!(await signal(controller, 'HUP'))) return stopped;
  const deadline = Date.now() + RELOAD_TIMEOUT_SECONDS * 1000;
  while (Date.now() < deadline) {
    await Bun.sleep(RELOAD_POLL_MS);
    const current = await docker.inspect(controller.id);
    const progress = await read_progress(current);
    if (progress.reload && progress.reload.seq > asked_seq) {
      if (progress.reload.ok === false) {
        return { error: progress.reload.error ?? 'Reload failed.', code: 'reload_failed' };
      }
      await workflow_groups_repo.save_deployed(
        row.id,
        { ...(row.deployed ?? uploaded), config: uploaded.config },
        controller.id
      );
      return null;
    }
    if (!current.running || progress.finished) return stopped;
  }
  return {
    error: `The Global Controller did not finish reloading within ${RELOAD_TIMEOUT_SECONDS} seconds.`,
    code: 'reload_timeout',
  };
}

// The code of an action that failed with an error of its own; `none` does nothing to fail.
const FAILURE_OF_ACTION: Record<ApplyAction, ApplyFailureCode> = {
  none: 'start_failed',
  start: 'start_failed',
  restart: 'stop_failed',
  stop: 'stop_failed',
  reload: 'reload_failed',
};

/** Brings the container in line with the upload once, holding the workflow group's lock. */
async function apply_once(workflow_group_id: string): Promise<void> {
  await with_group_lock(workflow_group_id, async () => {
    let row = await workflow_groups_repo.find(workflow_group_id);
    if (!row) return;
    const controller = await find_controller(workflow_group_id);
    // An upload that went into another container's volume is not in this one's.
    if (controller && row.controller_container_id !== controller.id) {
      row = await workflow_groups_repo.claim(workflow_group_id, controller.id);
    }
    const { generation } = row;
    const uploaded = uploaded_fingerprints(row);
    const action = choose_action(
      is_ready(row),
      controller?.running ?? false,
      uploaded,
      row.deployed
    );
    const state = group(workflow_group_id);
    state.applying = action === 'none' ? null : action;
    let failure: Failure | null = null;
    try {
      if (controller && (action === 'stop' || action === 'restart')) {
        failure = await stop_controller(controller);
      }
      if (action === 'start' || (action === 'restart' && !failure)) {
        failure = await start(row, controller, uploaded);
      } else if (controller && action === 'reload') {
        failure = await reload(row, controller, uploaded);
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
      const controller = await find_controller(workflow_group_id);
      if (!controller?.running) break;
      if ((await read_progress(controller)).phase !== 'starting') break;
      await changed(workflow_group_id, STARTING_POLL_MS);
      row = await workflow_groups_repo.find(workflow_group_id);
      if (!row) return;
    }
    await apply_once(workflow_group_id);
  }
}
