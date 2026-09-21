import { DEPLOYMENT_STATUSES, is_terminal_deployment_status } from '@cc-forge/api/deploy';
import type { DeploymentStatus } from '@cc-forge/api/deploy';

export interface DeployStagePlan {
  readonly status: DeploymentStatus;
  readonly label: string;
  readonly detail: string;
}

const STAGE_COPY: Record<DeploymentStatus, { label: string; detail: string }> = {
  pending: { label: 'Pending', detail: 'Deployment queued' },
  receiving_files: { label: 'Receiving files', detail: 'Uploading project bundle' },
  processing_files: { label: 'Processing files', detail: 'Validating & compiling config' },
  provisioning_resources: {
    label: 'Provisioning resources',
    detail: 'Requesting compute, network & database',
  },
  launching_resources: { label: 'Launching resources', detail: 'Starting instances & runtime' },
  success: { label: 'Live', detail: 'Deployment succeeded' },
  failed: { label: 'Failed', detail: 'Deployment failed' },
  stopping: { label: 'Stopping', detail: 'Tearing down instances' },
  stopped: { label: 'Stopped', detail: 'Instances terminated' },
  stop_failed: { label: 'Live', detail: 'Still running — the last stop did not finish' },
};

// `failed` recolours the active stage instead of owning one, and teardown is a separate lifecycle
// off the end of this one — neither gets a stage.
export const DEPLOY_STAGES: readonly DeployStagePlan[] = DEPLOYMENT_STATUSES.filter(
  (status) =>
    status !== 'failed' && status !== 'stopping' && status !== 'stopped' && status !== 'stop_failed'
).map((status) => ({ status, ...STAGE_COPY[status] }));

export function statusToCursor(status: DeploymentStatus): number {
  const index = DEPLOY_STAGES.findIndex((stage) => stage.status === status);
  return index < 0 ? 0 : index;
}

export function deploymentStatusLabel(status: DeploymentStatus): string {
  return STAGE_COPY[status].label;
}

export function isDeploymentActive(status: DeploymentStatus): boolean {
  return !is_terminal_deployment_status(status);
}
