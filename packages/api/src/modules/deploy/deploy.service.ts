import { config } from '@core/env';
import { badRequest, conflict, notFound } from '@core/errors';
import { LOG_DOMAINS, logger } from '@core/logger';

import { projects_repo } from '../projects/projects.repo';
import { call_deployed_agent } from './deploy.agent';
import { deploy_setups_repo, deployments_repo } from './deploy.repo';
import { DeployProviderId } from './deploy.types';
import { run_mock_deploy, run_mock_stop } from './deploy.worker.mock';
import type { DeploymentInfoRow } from './deploy.repo';
import type {
  DeployConfig,
  DeploymentInfo,
  DeploymentOverviewItem,
  DeploymentStateFilter,
  DeployProvider,
  DeployStopAccepted,
  DeployStopCapability,
  DeployTestBody,
  DeployTestResult,
  ProjectDeployAccepted,
  ProjectDeploySummary,
} from './deploy.types';

const deploy_logger = logger.child({ domain: LOG_DOMAINS.DEPLOY });

const DEPLOY_PROVIDER_CATALOG = [
  { id: DeployProviderId.AWS, name: 'AWS' },
  { id: DeployProviderId.GCP, name: 'GCP' },
] as const;
const STOP_REQUIRES_REDEPLOY_MESSAGE =
  'This deployment predates Stop support. Deploy again before stopping it.';
const STOP_NOT_LIVE_MESSAGE = 'This deployment is no longer running.';
const DEPLOY_UNAVAILABLE_MESSAGE = 'This installation has no deploy worker, so it cannot deploy.';

function assert_deploy_worker_configured(): void {
  if (config.deploy.worker === 'none') {
    throw conflict('deploy.unavailable', DEPLOY_UNAVAILABLE_MESSAGE);
  }
}

function resolve_selected_provider(provider_name: string) {
  return (
    DEPLOY_PROVIDER_CATALOG.find(
      (entry) => entry.name.toLowerCase() === provider_name.toLowerCase()
    ) ?? DEPLOY_PROVIDER_CATALOG[0]
  );
}

function stop_capability(deployment: {
  status: string;
  controller_instance_id: string | null;
}): DeployStopCapability {
  if (deployment.status === 'stopping') {
    return { available: true, code: 'available', message: null };
  }
  if (deployment.status !== 'success') {
    return { available: false, code: 'not_live', message: STOP_NOT_LIVE_MESSAGE };
  }
  if (!deployment.controller_instance_id) {
    return {
      available: false,
      code: 'missing_controller_identity',
      message: STOP_REQUIRES_REDEPLOY_MESSAGE,
    };
  }
  return { available: true, code: 'available', message: null };
}

function to_deployment_info(deployment: DeploymentInfoRow): DeploymentInfo {
  return {
    id: deployment.id,
    project_id: deployment.project_id,
    status: deployment.status,
    address: deployment.address,
    error: deployment.error,
    stop_error: deployment.stop_error,
    stop: stop_capability(deployment),
    created_at: deployment.created_at,
    updated_at: deployment.updated_at,
  };
}

// `company_id` is the project's owner company, resolved upstream: the deploy setup belongs to it.
async function get_deploy_target(company_id: string, project_id: string) {
  const project = await projects_repo.get_with_count(project_id);
  if (!project) {
    throw notFound('deploy.not_found', `No deploy target for project "${project_id}"`);
  }
  const setup = await deploy_setups_repo.find_one_by_company(company_id);
  if (!setup) throw notFound('deploy.not_found', 'No deploy setup for this account');
  return { project, setup };
}

export async function get_deploy_config(
  company_id: string,
  project_id: string
): Promise<DeployConfig> {
  const { project, setup } = await get_deploy_target(company_id, project_id);
  const selected = resolve_selected_provider(setup.provider);
  const providers: DeployProvider[] = DEPLOY_PROVIDER_CATALOG.map((entry) => ({
    id: entry.id,
    name: entry.name,
    enabled: entry.id === selected.id,
  }));
  const has_previous_deploy =
    (await deployments_repo.find_latest_success_by_project(project_id)) !== undefined;

  return {
    id: setup.id,
    project_id,
    name: setup.name,
    project_name: project.name,
    provider: selected.id,
    provider_name: selected.name,
    providers,
    status: { readiness: 'ready', label: `Ready to deploy to ${selected.name}` },
    has_previous_deploy,
  };
}

// The insert races against the partial unique index `uq_deployments_active_per_project`. Postgres
// reports the collision as SQLSTATE 23505; it is the only unique that this two-row insert can trip, so
// the code alone identifies "another active deployment won the race".
function is_active_conflict(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
  );
}

export async function trigger_deploy(
  company_id: string,
  user_id: string,
  project_id: string
): Promise<ProjectDeployAccepted> {
  assert_deploy_worker_configured();
  const { setup } = await get_deploy_target(company_id, project_id);
  const files = await projects_repo.get_deploy_files(project_id);
  if (files.length === 0) {
    throw badRequest('deploy.no_files', `Project "${project_id}" has no files to deploy`);
  }
  if (await deployments_repo.find_active_by_project(project_id)) {
    throw conflict(
      'deploy.already_running',
      `A deployment is already running for project "${project_id}"`
    );
  }

  let deployment;
  try {
    deployment = await deployments_repo.insert_pending_with_event(
      {
        project_id,
        company_id,
        created_by: user_id,
        deploy_setup_id: setup.id,
      },
      files
    );
  } catch (error) {
    if (is_active_conflict(error)) {
      throw conflict(
        'deploy.already_running',
        `A deployment is already running for project "${project_id}"`
      );
    }
    throw error;
  }

  deploy_logger.info('deploy enqueued', {
    deploy_id: deployment.id,
    project_id,
    deploy_setup_id: setup.id,
    provider: setup.provider,
    file_count: files.length,
  });

  if (config.deploy.worker === 'mock') {
    const deploy_id = deployment.id;
    void run_mock_deploy(deploy_id).catch((error) => {
      deploy_logger.error('mock deploy worker crashed', { deploy_id, error });
    });
  }

  return { deploy_id: deployment.id, project_id, status: 'accepted', file_count: files.length };
}

/**
 * Only a `success` row is stoppable — teardown needs the recorded controller handles. Re-requesting
 * an in-flight stop answers 202 without enqueueing a second teardown.
 */
export async function stop_deployment(
  project_id: string,
  deploy_id: string
): Promise<DeployStopAccepted> {
  assert_deploy_worker_configured();
  const stopping = await deployments_repo.request_stop(deploy_id, project_id);
  if (!stopping) {
    const current = await deployments_repo.find_by_project(deploy_id, project_id);
    if (!current) {
      throw notFound('deploy.not_found', `Deployment "${deploy_id}" was not found`);
    }
    if (current.status === 'success' && !current.controller_instance_id) {
      throw conflict(
        'deploy.missing_teardown_handles',
        'This deployment predates controller identity tracking and cannot be stopped safely; deploy again first'
      );
    }
    if (current.status !== 'stopping') {
      throw conflict(
        'deploy.not_stoppable',
        `Deployment "${deploy_id}" is ${current.status}, so it has nothing running to stop`
      );
    }
    return { deploy_id, project_id, status: 'stopping' };
  }

  deploy_logger.info('deploy stop requested', { deploy_id, project_id });

  if (config.deploy.worker === 'mock') {
    void run_mock_stop(deploy_id).catch((error) => {
      deploy_logger.error('mock stop worker crashed', { deploy_id, error });
    });
  }

  return { deploy_id, project_id, status: 'stopping' };
}

export async function get_deployment_info(
  project_id: string,
  deploy_id: string
): Promise<DeploymentInfo> {
  const deployment = await deployments_repo.find_info(deploy_id, project_id);
  if (!deployment) {
    throw notFound('deploy.not_found', `Deployment "${deploy_id}" was not found`);
  }
  return to_deployment_info(deployment);
}

export async function get_project_deploy_summary(
  project_id: string
): Promise<ProjectDeploySummary> {
  const [latest, active] = await Promise.all([
    deployments_repo.find_latest_terminal_by_project(project_id),
    deployments_repo.find_active_info_by_project(project_id),
  ]);
  return {
    latest: latest ? to_deployment_info(latest) : null,
    active: active ? to_deployment_info(active) : null,
  };
}

export async function list_deployment_overview(filter: {
  state: DeploymentStateFilter;
  limit: number;
}): Promise<DeploymentOverviewItem[]> {
  return deployments_repo.list_overview(filter);
}

export async function test_deployment(
  project_id: string,
  deploy_id: string,
  body: DeployTestBody
): Promise<DeployTestResult> {
  const deployment = await deployments_repo.find_for_test(deploy_id, project_id);
  if (!deployment) {
    throw notFound('deploy.not_found', `Deployment "${deploy_id}" was not found`);
  }
  if (!deployment.address) {
    throw conflict('deploy.no_address', `Deployment "${deploy_id}" has no live endpoint to test`);
  }
  const { status, text } = await call_deployed_agent(deployment.address, body);
  return { ok: status >= 200 && status < 300, status, body: parse_agent_body(text) };
}

function parse_agent_body(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Safety net for a worker that died mid-deploy: fail rows whose heartbeat is older than the lease and
 * publish the terminal event so open streams close. Called on boot and on an interval (never in test).
 */
export async function sweep_stale_deployments(): Promise<number> {
  return deployments_repo.sweep_stale(config.deploy.leaseSeconds);
}
