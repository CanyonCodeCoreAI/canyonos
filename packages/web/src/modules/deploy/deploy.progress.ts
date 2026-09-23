import type { DeploymentStatus } from '@canyonos/api/deploy';

import type { DeployStagePlan } from '@/modules/deploy/deploy.lifecycle';

export type DeployPhase = 'running' | 'complete' | 'failed';
export type DeployStageStatus = 'done' | 'active' | 'pending' | 'failed';

export interface DeployStageView {
  readonly status: DeploymentStatus;
  readonly label: string;
  readonly detail: string;
  readonly state: DeployStageStatus;
}

export interface DeployProgressView {
  readonly phase: DeployPhase;
  readonly totalStages: number;
  readonly doneCount: number;
  readonly pct: number;
  readonly elapsedLabel: string;
  readonly currentStatus: DeploymentStatus;
  readonly stages: readonly DeployStageView[];
}

const SECONDS_PER_STAGE = 14;

// Derives per-stage render state from the current cursor (index of the active status). The final
// stage is the terminal `success`; reaching it flips the phase to complete. A failed run marks the
// cursor's stage as failed and leaves later stages pending.
export function deriveDeployProgress(
  stages: readonly DeployStagePlan[],
  cursor: number,
  failed = false
): DeployProgressView {
  const total = stages.length;
  const clamped = Math.min(Math.max(cursor, 0), Math.max(total - 1, 0));
  const complete = !failed && clamped >= total - 1;

  const derivedStages = stages.map((stage, index) => {
    const state: DeployStageStatus =
      failed && index === clamped
        ? 'failed'
        : index < clamped
          ? 'done'
          : index === clamped
            ? complete
              ? 'done'
              : 'active'
            : 'pending';
    return {
      status: stage.status,
      label: stage.label,
      detail: stageDetail(stage.detail, state),
      state,
    };
  });

  const doneCount = derivedStages.filter((stage) => stage.state === 'done').length;
  const pct = total === 0 ? 0 : Math.round((doneCount / total) * 100);

  return {
    phase: failed ? 'failed' : complete ? 'complete' : 'running',
    totalStages: total,
    doneCount,
    pct,
    elapsedLabel: elapsedLabel(doneCount, complete),
    currentStatus: stages[clamped]?.status ?? 'pending',
    stages: derivedStages,
  };
}

function stageDetail(detail: string, state: DeployStageStatus): string {
  if (state === 'failed') return 'failed';
  if (state === 'active') return `${detail}…`;
  return detail;
}

function elapsedLabel(doneCount: number, complete: boolean): string {
  const seconds = doneCount * SECONDS_PER_STAGE + (complete ? 0 : 3);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
