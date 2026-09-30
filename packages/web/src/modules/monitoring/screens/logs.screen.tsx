import { useState } from 'react';

import type { MetricsWindow } from '@canyonos/api/metrics';

import { LogList } from '@/modules/monitoring/components/log-list';
import { ALL_SOURCES, LogSourceFilters } from '@/modules/monitoring/components/log-source-filters';
import { ProjectWindowControl } from '@/modules/projects/components/project-window-control';
import { DEFAULT_METRICS_WINDOW } from '@/modules/projects/projects.metrics';

interface LogsScreenProps {
  readonly project_id: string;
}

export function LogsScreen({ project_id }: LogsScreenProps) {
  const [time_window, setTimeWindow] = useState<MetricsWindow>(DEFAULT_METRICS_WINDOW);
  const [agent, setAgent] = useState(ALL_SOURCES);
  const [replica, setReplica] = useState(ALL_SOURCES);

  return (
    <main className="flex min-h-full flex-col gap-7 p-7" data-testid="logs-screen">
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <h1 className="text-foreground text-[1.5rem] leading-none font-bold tracking-tight">
            Logs
          </h1>
          <LogSourceFilters
            project_id={project_id}
            time_window={time_window}
            agent={agent}
            replica={replica}
            onAgentChange={setAgent}
            onReplicaChange={setReplica}
          />
        </div>
        <ProjectWindowControl value={time_window} onChange={setTimeWindow} />
      </header>

      <LogList
        project_id={project_id}
        time_window={time_window}
        agent={agent === ALL_SOURCES ? undefined : agent}
        replica={replica === ALL_SOURCES ? undefined : replica}
        empty_message="No logs recorded in this window."
        error_message="Could not load logs."
        test_id="logs"
      />
    </main>
  );
}
