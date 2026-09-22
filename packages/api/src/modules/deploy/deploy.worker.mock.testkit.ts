// Home for scripting the in-process mock deploy worker in tests. Every entry is gated on isTest, so a
// stray import in dev/prod is a no-op and the worker keeps running its deterministic happy path.
// Never import this from a feature module. Mirrors workflows.generation.testkit.ts.

import { config } from '@core/env';

import { __release_mock_deploy_hold, __set_mock_deploy_script } from './deploy.worker.mock';
import type { MockDeployScript } from './deploy.worker.mock';

/** Make the mock deploy fail at / hold at a phase, or the mock teardown throw (test suite only). */
export function set_mock_deploy_script(script: MockDeployScript): void {
  if (!config.isTest) return;
  __set_mock_deploy_script(script);
}

/** Clear any installed script, restoring the deterministic happy path. */
export function clear_mock_deploy_script(): void {
  if (!config.isTest) return;
  __set_mock_deploy_script(null);
}

/** Release a worker parked at `hold_at` so it can finish or observe a reclaim. */
export function release_hold(): void {
  if (!config.isTest) return;
  __release_mock_deploy_hold();
}
