import type { ReactNode } from 'react';

import type { MetricsWindow } from '@canyonos/api/metrics';

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
          className="-mx-5 shrink-0 justify-start px-5"
          data-testid="project-spend-tabs"
        >
          <TabsTrigger value="overview">{SPEND_TAB_LABEL.overview}</TabsTrigger>
          <TabsTrigger value="agent">{SPEND_TAB_LABEL.agent}</TabsTrigger>
          <TabsTrigger value="query">{SPEND_TAB_LABEL.query}</TabsTrigger>
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
