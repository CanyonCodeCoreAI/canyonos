import { LOG_DOMAINS, logger } from '@core/logger';

import { workflows_repo } from './workflows.repo';
import { workflows_service } from './workflows.service';
import type { WorkflowJob } from './workflows.repo';

const queue_logger = logger.child({ domain: LOG_DOMAINS.HTTP });

const pending = new Map<string, WorkflowJob>();
let running = false;
let idle_waiters: Array<() => void> = [];

const job_key = ({ project_id, workflow_id }: WorkflowJob): string =>
  `${project_id}:${workflow_id}`;

function resolve_idle_if_settled(): void {
  if (running || pending.size > 0) return;
  const waiters = idle_waiters;
  idle_waiters = [];
  for (const resolve of waiters) resolve();
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (pending.size > 0) {
      const [key, job] = pending.entries().next().value as [string, WorkflowJob];
      pending.delete(key);
      await workflows_service.regenerate(job.project_id, job.workflow_id);
    }
  } finally {
    running = false;
    resolve_idle_if_settled();
  }
}

function enqueue_job(job: WorkflowJob): void {
  pending.set(job_key(job), job);
}

export const workflows_queue = {
  enqueue(project_id: string, workflow_id: string): void {
    enqueue_job({ project_id, workflow_id });
    void drain();
  },

  enqueue_all(project_id: string, workflow_ids: readonly string[]): void {
    for (const workflow_id of workflow_ids) enqueue_job({ project_id, workflow_id });
    if (workflow_ids.length > 0) void drain();
  },

  idle(): Promise<void> {
    if (!running && pending.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => idle_waiters.push(resolve));
  },

  async sweep_and_enqueue(): Promise<void> {
    await workflows_repo.reclaim_orphaned_generations();
    const jobs = await workflows_repo.list_work_needed();
    for (const job of jobs) enqueue_job(job);
    if (jobs.length > 0) {
      queue_logger.info('workflow queue: swept pending work on boot', { count: jobs.length });
      void drain();
    }
  },
};
