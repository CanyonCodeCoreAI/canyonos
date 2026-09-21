import { useQuery } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { MetricsBlocks, MetricsWindow } from '@canyonos/api/metrics';

import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/shadcn/tabs';
import { cn } from '@repo/ui/utils';
import { apiCall, forgeAuthApi } from '@/api';
import { EmptyState } from '@/modules/core/components/EmptyState';
import { QueryError } from '@/modules/core/components/QueryError';
import { ProjectAgentShare } from '@/modules/projects/components/project-agent-share';
import {
  AnalyzeButton,
  AnalyzePreviewNote,
} from '@/modules/projects/components/project-analyze-button';
import { ProjectBlockDrawer } from '@/modules/projects/components/project-block-drawer';
import { ProjectMetricsSection } from '@/modules/projects/components/project-metrics-section';
import { analyzableAgents } from '@/modules/projects/projects.analysis';
import {
  formatCount,
  formatDurationMs,
  formatMoney,
  formatRate,
  formatShare,
  formatTokens,
  parseMoney,
} from '@/modules/projects/projects.format';
import { COST_SPLIT } from '@/modules/projects/projects.metrics';
import { dashboardPollInterval, projectQueryKeys } from '@/modules/projects/projects.query-cache';
import type { SelectedBlock } from '@/modules/projects/components/project-block-drawer';

const MISSING = '—';

const ROW_GRID_CLASS = 'grid-cols-[minmax(0,1fr)_5.5rem_5rem_5rem_5rem_4.5rem]';

const AGENT_VIEW_TRIGGER_CLASS =
  'focus-visible:ring-ring data-[state=active]:bg-card data-[state=inactive]:text-muted-foreground data-[state=inactive]:hover:text-foreground h-6 rounded-md px-2.5 text-xs font-semibold transition-[background-color,color,box-shadow,transform] duration-150 focus-visible:ring-2 active:scale-[0.97] data-[state=active]:shadow-xs';

const blocksQuery = (project_id: string, time_window: MetricsWindow) => ({
  queryKey: projectQueryKeys.metricsBlocks(project_id, time_window),
  queryFn: () =>
    apiCall<MetricsBlocks>(() =>
      forgeAuthApi.projects[project_id]!.metrics.blocks.get({ $query: { time_window } })
    ),
  retry: false,
  refetchInterval: dashboardPollInterval,
});

function AgentSpendSection({
  action,
  children,
}: {
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <ProjectMetricsSection
      title="Per-agent breakdown"
      description="Every agent that billed in this window, dearest first. Open one for its full breakdown."
      test_id="project-agent-section"
      className="min-h-0 flex-1"
      action={action}
    >
      {children}
    </ProjectMetricsSection>
  );
}

interface ProjectAgentSpendProps {
  readonly project_id: string;
  readonly time_window: MetricsWindow;
}

export function ProjectAgentSpend({ project_id, time_window }: ProjectAgentSpendProps) {
  const blocks_query = useQuery(blocksQuery(project_id, time_window));
  const [selected, setSelected] = useState<SelectedBlock | null>(null);
  const rows_ref = useRef<HTMLDivElement>(null);
  const return_agent_id = useRef<string | null>(null);
  const preview_id = useId();

  if (blocks_query.isPending) {
    return (
      <AgentSpendSection>
        <Skeleton
          className="min-h-0 flex-1 rounded-[1.125rem]"
          data-testid="project-agents-loading"
        />
      </AgentSpendSection>
    );
  }

  if (blocks_query.error) {
    return (
      <AgentSpendSection>
        <QueryError
          message="Could not load per-agent spend."
          onRetry={() => void blocks_query.refetch()}
          test_id="project-agents-error"
        />
      </AgentSpendSection>
    );
  }

  const total = parseMoney(blocks_query.data.total_cost);
  const rows = blocks_query.data.blocks.toSorted(
    (left, right) => parseMoney(right.cost) - parseMoney(left.cost)
  );

  const analyzable = analyzableAgents(rows);
  const selectBlock = (block: SelectedBlock | null) => {
    if (block !== null) return_agent_id.current = block.agent_id;
    setSelected(block);
  };

  if (rows.length === 0) {
    return (
      <AgentSpendSection>
        <EmptyState size="section" test_id="project-agents-empty">
          <p>No blocks executed in this window, so nothing has billed yet.</p>
        </EmptyState>
      </AgentSpendSection>
    );
  }

  return (
    <Tabs defaultValue="pie" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <AgentSpendSection
        action={
          <TabsList
            aria-label="Agent spend view"
            className="border-border/70 bg-muted/70 inline-flex h-8 rounded-lg border p-0.5"
            data-testid="project-agent-view-toggle"
          >
            <TabsTrigger value="pie" className={AGENT_VIEW_TRIGGER_CLASS}>
              Pie
            </TabsTrigger>
            <TabsTrigger value="list" className={AGENT_VIEW_TRIGGER_CLASS}>
              List
            </TabsTrigger>
          </TabsList>
        }
      >
        <div
          className="flex min-h-0 min-w-0 flex-1 flex-col gap-2"
          ref={rows_ref}
          data-testid="project-agents"
        >
          <TabsContent value="pie" className="mt-0">
            <ProjectAgentShare
              rows={rows}
              total={total}
              onSelectBlock={selectBlock}
              analyzable={analyzable}
              preview_id={preview_id}
            />
          </TabsContent>
          <TabsContent value="list" className="mt-0 flex min-h-0 min-w-0 flex-1 flex-col">
            <div
              role="region"
              aria-label="Agent spend list"
              data-testid="project-agent-list-scroll"
              className="scroll-area min-h-0 flex-1 overflow-y-auto rounded-lg"
            >
              <div
                className={cn(
                  'text-muted-foreground bg-card sticky top-0 z-[2] grid gap-3 px-3 pb-2 text-[0.65625rem] font-semibold tracking-[0.05em] uppercase max-lg:hidden',
                  ROW_GRID_CLASS
                )}
              >
                <span>Agent</span>
                <span className="text-right">Cost</span>
                <span className="text-right">Share</span>
                <span className="text-right">Blocks</span>
                <span className="text-right">Tokens</span>
                <span className="text-right">p95</span>
              </div>

              <ul className="flex flex-col">
                {rows.map((block) => {
                  const cost = parseMoney(block.cost);
                  const model_led = parseMoney(block.llm_cost) >= parseMoney(block.harness_cost);
                  const side = model_led ? COST_SPLIT.llm_cost : COST_SPLIT.harness_cost;
                  const analyzable_row = analyzable.has(block.agent_id);

                  return (
                    <li
                      key={`${block.agent_id}-${block.label}`}
                      className={cn(
                        'relative grid items-center gap-3 rounded-lg px-3 py-2.5 transition-colors',
                        ROW_GRID_CLASS,
                        'has-[button:enabled]:hover:bg-muted/60',
                        'has-[button:focus-visible]:ring-ring has-[button:focus-visible]:ring-2 has-[button:focus-visible]:ring-inset',
                        'max-lg:flex max-lg:flex-wrap max-lg:gap-x-4'
                      )}
                    >
                      <button
                        type="button"
                        onClick={() =>
                          selectBlock({ agent_id: block.agent_id, label: block.label })
                        }
                        aria-label={`Open metrics for ${block.label}`}
                        data-testid={`project-agent-row-${block.agent_id}`}
                        className="absolute inset-0 z-[1] rounded-lg outline-none"
                      />
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          className="size-2 shrink-0 rounded-sm"
                          style={{ backgroundColor: side.color }}
                          aria-hidden
                        />
                        <span className="text-foreground min-w-0 truncate font-mono text-[0.8125rem]">
                          {block.label}
                        </span>
                        <span className="text-muted-foreground shrink-0 text-[0.6875rem]">
                          {side.label}
                        </span>
                        {analyzable_row ? (
                          <AnalyzeButton
                            subject={block.label}
                            describedBy={preview_id}
                            test_id={`project-agent-analyze-${block.agent_id}`}
                          />
                        ) : null}
                      </span>
                      <span className="text-foreground text-right font-mono text-[0.8125rem] tabular-nums">
                        {formatMoney(block.cost)}
                      </span>
                      <span className="text-muted-foreground text-right font-mono text-xs tabular-nums">
                        {formatShare(cost, total)}
                      </span>
                      <span className="text-muted-foreground text-right font-mono text-xs tabular-nums">
                        {formatCount(block.block_count)}
                      </span>
                      <span className="text-muted-foreground text-right font-mono text-xs tabular-nums">
                        {formatTokens(block.token_count)}
                      </span>
                      <span className="text-muted-foreground text-right font-mono text-xs tabular-nums">
                        {block.p95_latency_ms === null
                          ? MISSING
                          : formatDurationMs(block.p95_latency_ms)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </TabsContent>

          <p className="text-muted-foreground shrink-0 px-3 text-xs">
            {formatCount(rows.length)} {rows.length === 1 ? 'agent' : 'agents'} ·{' '}
            {formatMoney(blocks_query.data.total_cost)} across the window
            {rows[0]?.retry_rate !== null && rows[0] !== undefined
              ? ` · dearest retries ${formatRate(rows[0].retry_rate)}`
              : ''}
          </p>

          {analyzable.size > 0 ? <AnalyzePreviewNote id={preview_id} /> : null}

          <ProjectBlockDrawer
            project_id={project_id}
            block={selected}
            onSelect={selectBlock}
            returnFocusTo={() =>
              return_agent_id.current
                ? (rows_ref.current?.querySelector<HTMLElement>(
                    `[data-testid="project-agent-row-${return_agent_id.current}"], [data-testid="project-agent-share-row-${return_agent_id.current}"]`
                  ) ?? null)
                : null
            }
          />
        </div>
      </AgentSpendSection>
    </Tabs>
  );
}
