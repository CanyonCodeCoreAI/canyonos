import { WorkflowIcon } from 'lucide-react';

import type { WorkflowHeroModel } from '@/modules/workflows/workflows.selectors';

interface WorkflowHeroProps {
  model: WorkflowHeroModel;
}

export function WorkflowHero({ model }: WorkflowHeroProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="workflow-hero">
      <h1 className="text-foreground text-[1.6875rem] leading-tight font-bold tracking-tight">
        {model.name}
      </h1>
      <span className="bg-primary/10 text-primary inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold">
        <WorkflowIcon className="size-3.25" strokeWidth={2.1} aria-hidden />
        Workflow design
      </span>
      <span className="bg-muted text-muted-foreground inline-flex items-center rounded-md px-2 py-1 font-mono text-xs whitespace-nowrap">
        {model.workflow_file}
      </span>
    </div>
  );
}
