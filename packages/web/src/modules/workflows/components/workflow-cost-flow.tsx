// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from 'react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/shadcn/tabs';
import { WorkflowAgentSpend } from '@/modules/workflows/components/workflow-agent-spend';
import { WorkflowCostTimeseries } from '@/modules/workflows/components/workflow-cost-timeseries';
import { WorkflowMetricsSection } from '@/modules/workflows/components/workflow-metrics-section';
import { WorkflowSpendHighlights } from '@/modules/workflows/components/workflow-spend-highlights';
import type { RangeSelection } from '@/modules/core/time-range';

export type SpendTab = 'overview' | 'agent' | 'query';

const SPEND_TAB_LABEL: Record<SpendTab, string> = {
  overview: 'Overview',
  agent: 'Per-Agent view',
  query: 'Per-Query view',
};

const SPEND_TITLE = 'Where the money sits';
const SPEND_DESCRIPTION =
  'Spend across the selected range, read three ways — over time, by agent, and by query.';

function isSpendTab(value: string): value is SpendTab {
  return value === 'overview' || value === 'agent' || value === 'query';
}

interface WorkflowCostFlowProps {
  readonly workflow_id: string;
  readonly range: RangeSelection;
  readonly tab: SpendTab;
  readonly onTabChange: (tab: SpendTab) => void;
  readonly query_panel: ReactNode;
}

export function WorkflowCostFlow({
  workflow_id,
  range,
  tab,
  onTabChange,
  query_panel,
}: WorkflowCostFlowProps) {
  return (
    <WorkflowMetricsSection
      title={SPEND_TITLE}
      description={SPEND_DESCRIPTION}
      test_id="workflow-cost-flow"
      // Fits the viewport only while it holds a list that scrolls; every other view keeps its height.
      className="has-[.scroll-area]:min-h-0"
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
          data-testid="workflow-spend-tabs"
        >
          <TabsTrigger value="overview">{SPEND_TAB_LABEL.overview}</TabsTrigger>
          <TabsTrigger value="agent">{SPEND_TAB_LABEL.agent}</TabsTrigger>
          <TabsTrigger value="query">{SPEND_TAB_LABEL.query}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-0 flex min-w-0 flex-col gap-5">
          <WorkflowCostTimeseries workflow_id={workflow_id} range={range} framed={false} />
          <WorkflowSpendHighlights workflow_id={workflow_id} range={range} />
        </TabsContent>
        <TabsContent value="agent" className="mt-0 flex min-h-0 min-w-0 flex-1 flex-col">
          <WorkflowAgentSpend workflow_id={workflow_id} range={range} />
        </TabsContent>
        <TabsContent value="query" className="mt-0">
          {query_panel}
        </TabsContent>
      </Tabs>
    </WorkflowMetricsSection>
  );
}
