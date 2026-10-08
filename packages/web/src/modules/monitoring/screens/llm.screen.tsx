import type { MetricsWindow } from '@canyonos/api/metrics';

import { LlmCallList } from '@/modules/monitoring/components/llm-call-list';
import { ProjectWindowControl } from '@/modules/projects/components/project-window-control';

interface LlmScreenProps {
  readonly project_id: string;
  readonly time_window: MetricsWindow;
}

export function LlmScreen({ project_id, time_window }: LlmScreenProps) {
  return (
    <main className="flex min-h-full shrink-0 flex-col gap-7 p-7" data-testid="llm-screen">
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <h1 className="text-foreground text-[1.5rem] leading-none font-bold tracking-tight">LLM</h1>
        <ProjectWindowControl />
      </header>

      <LlmCallList project_id={project_id} time_window={time_window} />
    </main>
  );
}
