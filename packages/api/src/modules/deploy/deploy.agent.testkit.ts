// Home for stubbing the outbound deployed-agent call in tests, so the suite exercises the proxy
// without hitting the network. Every entry is gated on isTest; a stray import in dev/prod is a no-op.
// Never import this from a feature module. Mirrors deploy.worker.mock.testkit.ts.

import { config } from '@core/env';

import { __set_agent_caller, __set_agent_poll } from './deploy.agent';
import type { AgentCaller } from './deploy.agent';

/** Install a stub for the outbound agent transport (test suite only). */
export function set_deploy_agent_caller(caller: AgentCaller): void {
  if (!config.isTest) return;
  __set_agent_caller(caller);
}

/** Shrink the status poll cadence so async-completion tests don't wait on real timing. */
export function set_deploy_agent_poll(poll: { interval_ms: number; timeout_ms: number }): void {
  if (!config.isTest) return;
  __set_agent_poll(poll);
}

/** Restore the real fetch-based transport and the default poll cadence. */
export function clear_deploy_agent_caller(): void {
  if (!config.isTest) return;
  __set_agent_caller(null);
  __set_agent_poll(null);
}
