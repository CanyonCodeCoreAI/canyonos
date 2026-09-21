import type { ReactNode } from 'react';

import type { MetricsWindow } from '@cc-forge/api/metrics';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/shadcn/tabs';
import { ProjectAgentSpend } from '@/modules/projects/components/project-agent-spend';
import { ProjectCostTimeseries } from '@/modules/projects/components/project-cost-timeseries';
import { ProjectMetricsSection } from '@/modules/projects/components/project-metrics-section';
import { ProjectSpendHighlights } from '@/modules/projects/components/project-spend-highlights';

export type SpendTab = 'overview' | 'agent' | 'query';

const SPEND_TAB_LABEL: Record<SpendTab, string> = {
  overview: 'Overview',
  agent: 'Per-Agent view',
  query: 'Per-Query view',
};

const SPEND_TITLE = 'Where the money sits';
const SPEND_DESCRIPTION =
  'Spend across the selected window, read three ways — over time, by agent, and by query.';

const SPEND_TAB_TRIGGER_CLASS =
  'focus-visible:ring-ring data-[state=active]:border-border data-[state=active]:border-b-card data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=inactive]:text-muted-foreground data-[state=inactive]:hover:bg-card/50 data-[state=inactive]:hover:text-foreground relative -mb-px rounded-t-[0.625rem] rounded-b-none border border-transparent px-4 pt-2 pb-2.5 text-[0.8125rem] font-semibold transition-[background-color,color] duration-150 focus-visible:ring-2 data-[state=active]:shadow-none';

function isSpendTab(value: string): value is SpendTab {
  return value === 'overview' || value === 'agent' || value === 'query';
}

interface ProjectCostFlowProps {
  readonly project_id: string;
  readonly time_window: MetricsWindow;
  readonly tab: SpendTab;
  readonly onTabChange: (tab: SpendTab) => void;
  readonly query_panel: ReactNode;
}

export function ProjectCostFlow({
  project_id,
  time_window,
  tab,
  onTabChange,
  query_panel,
}: ProjectCostFlowProps) {
  return (
    <ProjectMetricsSection
      title={SPEND_TITLE}
      description={SPEND_DESCRIPTION}
      test_id="project-cost-flow"
      className="min-h-0"
      framed
    >
      <Tabs
        value={tab}
        onValueChange={(value) => {
          if (isSpendTab(value)) onTabChange(value);
        }}
        className="flex min-h-0 min-w-0 flex-1 flex-col gap-4"
      >
        <TabsList
          aria-label="Spend view"
          className="border-border bg-muted/60 -mx-5 flex h-auto shrink-0 items-end justify-start gap-1 rounded-none border-b px-4 pt-1.5 pb-0"
          data-testid="project-spend-tabs"
        >
          <TabsTrigger value="overview" className={SPEND_TAB_TRIGGER_CLASS}>
            {SPEND_TAB_LABEL.overview}
          </TabsTrigger>
          <TabsTrigger value="agent" className={SPEND_TAB_TRIGGER_CLASS}>
            {SPEND_TAB_LABEL.agent}
          </TabsTrigger>
          <TabsTrigger value="query" className={SPEND_TAB_TRIGGER_CLASS}>
            {SPEND_TAB_LABEL.query}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-0 flex min-w-0 flex-col gap-5">
          <ProjectCostTimeseries project_id={project_id} time_window={time_window} framed={false} />
          <ProjectSpendHighlights project_id={project_id} time_window={time_window} />
        </TabsContent>
        <TabsContent value="agent" className="mt-0 flex min-h-0 min-w-0 flex-1 flex-col">
          <ProjectAgentSpend project_id={project_id} time_window={time_window} />
        </TabsContent>
        <TabsContent value="query" className="mt-0">
          {query_panel}
        </TabsContent>
      </Tabs>
    </ProjectMetricsSection>
  );
}
