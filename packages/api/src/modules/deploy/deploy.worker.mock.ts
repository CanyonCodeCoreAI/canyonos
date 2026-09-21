import { config } from '@core/env';
import { LOG_DOMAINS, logger } from '@core/logger';
import { record } from '@core/telemetry';

import { deployments_repo } from './deploy.repo';
import type { DeploymentPhase } from './deploy.types';

const worker_logger = logger.child({ domain: LOG_DOMAINS.WORKER });

const MOCK_WORKER_VERSION = 'mock';
const MOCK_ADDRESS = '203.0.113.42';
const HEARTBEAT_INTERVAL_MS = 15_000;

// The phases the systems worker drives, in order; the terminal success is applied after the loop. The
// real Python worker calls boto3/ssh/rclone/ventis at each step — here it is only a Bun.sleep.
const PHASES: readonly DeploymentPhase[] = [
  'receiving_files',
  'processing_files',
  'provisioning_resources',
  'launching_resources',
];

export interface MockDeployScript {
  readonly fail_at?: DeploymentPhase;
  readonly fail_message?: string;
  readonly hold_at?: DeploymentPhase;
  readonly throw_at?: DeploymentPhase;
  readonly throw_message?: string;
  readonly stop_throw_message?: string;
  readonly heartbeat_interval_ms?: number;
}

// Null in production and until a test installs a script, so the worker just runs the happy path. The
// hooks below are the only writers; they are gated behind the testkit (see deploy.worker.mock.testkit).
let script: MockDeployScript | null = null;
const hold_releases = new Set<() => void>();

/** @internal Test seam — install/clear the fault-injection script. See the testkit. */
export function __set_mock_deploy_script(next: MockDeployScript | null): void {
  script = next;
}

/** @internal Release a worker parked at `hold_at`; no-op when nothing is held. */
export function __release_mock_deploy_hold(): void {
  for (const release of hold_releases) release();
  hold_releases.clear();
}

function wait_for_release(): Promise<void> {
  return new Promise<void>((resolve) => {
    const release = () => {
      hold_releases.delete(release);
      resolve();
    };
    hold_releases.add(release);
  });
}

// Dev-only: `DEPLOY_MOCK_HOLD_AT` parks the mock worker at a phase so the in-progress screen can be
// inspected there. An installed test script's `hold_at` always wins; the config value is unset in test.
function config_hold_phase(): DeploymentPhase | undefined {
  const value = config.deploy.mockHoldAt;
  if (!value) return undefined;
  if ((PHASES as readonly string[]).includes(value)) return value as DeploymentPhase;
  worker_logger.warn('ignoring invalid DEPLOY_MOCK_HOLD_AT', { value, valid: PHASES });
  return undefined;
}

function start_heartbeat(
  deployment_id: string,
  heartbeat_interval_ms?: number
): () => Promise<void> {
  const interval_ms = Math.max(
    1,
    heartbeat_interval_ms ??
      Math.max(1_000, Math.min(HEARTBEAT_INTERVAL_MS, (config.deploy.leaseSeconds * 1_000) / 3))
  );
  let in_flight = Promise.resolve();
  const timer = setInterval(() => {
    in_flight = in_flight
      .then(() => deployments_repo.heartbeat_claimed(deployment_id))
      .catch((error) => {
        worker_logger.error('mock deploy heartbeat failed', { deployment_id, error });
      });
  }, interval_ms);

  return async () => {
    clearInterval(timer);
    await in_flight;
  };
}

/**
 * In-process stand-in for the Python EC2 worker. It performs the SAME DB writes the real worker will —
 * a claim, then a status+event transaction per phase, then the terminal success — with `Bun.sleep`
 * where the real worker would reach AWS/ventis. Fire-and-forget: the durable rows are the truth.
 */
export function run_mock_deploy(deployment_id: string): Promise<void> {
  return Promise.resolve(
    record('deploy.mock.run', () => drive_deployment(deployment_id), { deployment_id })
  );
}

/** Stand-in for the Python worker's teardown: claim the 'stopping' row, mark it 'stopped'. */
export function run_mock_stop(deployment_id: string): Promise<void> {
  return Promise.resolve(
    record('deploy.mock.stop', () => drive_teardown(deployment_id), { deployment_id })
  );
}

async function drive_teardown(deployment_id: string): Promise<void> {
  const claimed = await deployments_repo.claim_stopping(deployment_id, MOCK_WORKER_VERSION);
  if (!claimed) {
    worker_logger.warn('mock stop: nothing to claim', { deployment_id });
    return;
  }

  const run_script = script;
  const stop_heartbeat = start_heartbeat(deployment_id, run_script?.heartbeat_interval_ms);
  try {
    await Bun.sleep(config.deploy.mockStepMs);
    if (run_script?.stop_throw_message) throw new Error(run_script.stop_throw_message);
    await deployments_repo.advance_status_with_event(deployment_id, 'stopped');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    worker_logger.error('mock stop failed unexpectedly', { deployment_id, error });
    await deployments_repo.mark_stop_failed_with_event(deployment_id, message);
  } finally {
    await stop_heartbeat();
  }
}

async function drive_deployment(deployment_id: string): Promise<void> {
  const claimed = await deployments_repo.claim_pending(deployment_id, MOCK_WORKER_VERSION);
  if (!claimed) {
    worker_logger.warn('mock deploy: nothing to claim', { deployment_id });
    return;
  }

  const run_script = script;
  const hold_at = run_script?.hold_at ?? config_hold_phase();
  const stop_heartbeat = start_heartbeat(deployment_id, run_script?.heartbeat_interval_ms);
  try {
    for (const phase of PHASES) {
      await Bun.sleep(config.deploy.mockStepMs);
      if (run_script?.throw_at === phase) {
        throw new Error(run_script.throw_message ?? `mock deploy crashed at ${phase}`);
      }
      if (run_script?.fail_at === phase) {
        await deployments_repo.mark_failed_with_event(
          deployment_id,
          run_script.fail_message ?? `mock deploy failed at ${phase}`
        );
        return;
      }
      const advanced = await deployments_repo.advance_status_with_event(deployment_id, phase);
      if (!advanced) return;
      if (hold_at === phase) await wait_for_release();
    }

    await deployments_repo.record_controller_handles(
      deployment_id,
      'i-mock-controller',
      '203.0.113.10'
    );
    await deployments_repo.advance_status_with_event(deployment_id, 'success', MOCK_ADDRESS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    worker_logger.error('mock deploy failed unexpectedly', { deployment_id, error });
    await deployments_repo.mark_failed_with_event(deployment_id, message);
  } finally {
    await stop_heartbeat();
  }
}
