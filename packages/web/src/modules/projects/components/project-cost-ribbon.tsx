import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';

import type { KpiWindow, MetricsKpis, MetricsWindow } from '@cc-forge/api/metrics';

import { Badge } from '@repo/ui/shadcn/badge';
import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@repo/ui/shadcn/tooltip';
import { cn } from '@repo/ui/utils';
import { QueryError } from '@/modules/core/components/QueryError';
import { ProjectMetricsSection } from '@/modules/projects/components/project-metrics-section';
import {
  formatCount,
  formatMoney,
  formatShare,
  formatTokens,
  parseMoney,
} from '@/modules/projects/projects.format';
import { COST_SPLIT } from '@/modules/projects/projects.metrics';
import { projectKpisQueryOptions } from '@/modules/projects/projects.queries';

const RIBBON =
  'border-border bg-card grid overflow-hidden rounded-2xl border shadow-xs sm:grid-cols-2 lg:grid-cols-5';

interface ProjectCostRibbonProps {
  readonly project_id: string;
  readonly time_window: MetricsWindow;
}

export function ProjectCostRibbon({ project_id, time_window }: ProjectCostRibbonProps) {
  const kpis_query = useQuery(projectKpisQueryOptions(project_id));

  return (
    <ProjectMetricsSection test_id="project-cost-ribbon">
      <RibbonBody query={kpis_query} time_window={time_window} />
    </ProjectMetricsSection>
  );
}

/**
 * How much of a window reported a cost at all.
 *
 * A block the source never priced is not a free block, so every figure derived from cost covers the
 * priced blocks alone. `complete` is the state where that qualification is unnecessary.
 */
export type CostCoverage =
  | { readonly state: 'complete' }
  | { readonly state: 'unavailable' }
  | {
      readonly state: 'partial';
      readonly costed_block_count: number;
      readonly block_count: number;
      readonly costed_request_count: number;
      readonly request_count: number;
    };

type QualifiedCoverage = Exclude<CostCoverage, { readonly state: 'complete' }>;

// Shared by the ribbon, timeseries stats rail, and spend highlights so a figure and its coverage
// badge can never disagree about which state they are in.
export function costCoverage(kpi: KpiWindow): CostCoverage {
  // A window that ran nothing has nothing to qualify. Anything that did run and priced none of it
  // is unavailable, never complete.
  if (kpi.request_count === 0 && kpi.block_count === 0) return { state: 'complete' };
  if (kpi.costed_block_count === 0) return { state: 'unavailable' };
  if (
    kpi.costed_block_count === kpi.block_count &&
    kpi.costed_request_count === kpi.request_count
  ) {
    return { state: 'complete' };
  }
  return {
    state: 'partial',
    costed_block_count: kpi.costed_block_count,
    block_count: kpi.block_count,
    costed_request_count: kpi.costed_request_count,
    request_count: kpi.request_count,
  };
}

const COVERAGE_LABEL: Record<QualifiedCoverage['state'], string> = {
  partial: 'Partial',
  unavailable: 'Unavailable',
};

function coverageDescription(coverage: QualifiedCoverage): string {
  switch (coverage.state) {
    case 'unavailable':
      return 'No blocks in this range report cost data, so every figure below that depends on cost is empty.';
    case 'partial':
      return `Cost covers ${formatCount(coverage.costed_block_count)} of ${formatCount(coverage.block_count)} blocks across ${formatCount(coverage.costed_request_count)} of ${formatCount(coverage.request_count)} queries in this range.`;
  }
}

// No `TooltipProvider` here — the caller wraps every badge on a screen in one shared provider so
// they don't each open a separate delay timer and portal root.
export function CostCoverageBadge({
  kpi,
  test_id,
}: {
  readonly kpi: KpiWindow;
  readonly test_id: string;
}) {
  const coverage = costCoverage(kpi);
  if (coverage.state === 'complete') return null;

  const description = coverageDescription(coverage);
  const description_id = `${test_id}-coverage-description`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`Cost data ${COVERAGE_LABEL[coverage.state].toLowerCase()}`}
          // Radix tooltips never open on tap, so the accessible description lives in the hidden
          // span below, not only in the tooltip.
          aria-describedby={description_id}
          data-testid={`${test_id}-coverage`}
          data-coverage={coverage.state}
          className="focus-visible:ring-ring shrink-0 rounded-full focus-visible:ring-2 focus-visible:outline-none"
        >
          <Badge variant="outline" className="px-2 py-0 text-[0.625rem]">
            {COVERAGE_LABEL[coverage.state]}
          </Badge>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{description}</TooltipContent>
      <span id={description_id} className="sr-only">
        {description}
      </span>
    </Tooltip>
  );
}

function RibbonCell({
  label,
  value,
  hint,
  color,
  test_id,
  kpi,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint: string;
  readonly color?: string;
  readonly test_id: string;
  /** Present on the cells whose figure depends on how much of the window reported a cost. */
  readonly kpi?: KpiWindow;
}) {
  return (
    <div
      className="border-border/70 flex min-w-0 flex-col gap-1.5 px-[1.0625rem] py-[0.9375rem] not-first:border-t sm:not-first:border-t-0 sm:even:border-l lg:not-first:border-l lg:even:border-l"
      data-testid={test_id}
    >
      <span className="flex min-w-0 items-center justify-between gap-2">
        <span className="text-muted-foreground truncate text-[0.65625rem] font-semibold tracking-[0.05em] uppercase">
          {label}
        </span>
        {kpi ? <CostCoverageBadge kpi={kpi} test_id={test_id} /> : null}
      </span>
      <span
        className={cn(
          'truncate font-mono text-[1.5rem] leading-none font-semibold tracking-[-0.02em] tabular-nums',
          color ? undefined : 'text-foreground'
        )}
        style={color ? { color } : undefined}
      >
        {value}
      </span>
      <span className="text-muted-foreground text-[0.71875rem] leading-snug text-pretty">
        {hint}
      </span>
    </div>
  );
}

function RibbonBody({
  query,
  time_window,
}: {
  readonly query: UseQueryResult<MetricsKpis>;
  readonly time_window: MetricsWindow;
}) {
  if (query.isPending) {
    return (
      <div className={RIBBON} aria-busy data-testid="project-cost-ribbon-loading">
        {['queries', 'spend', 'model', 'harness', 'per-query'].map((key) => (
          <div
            key={key}
            className="border-border/70 flex flex-col gap-2 p-[1.0625rem] lg:not-first:border-l"
          >
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-6 w-28" />
            <Skeleton className="h-3 w-32" />
          </div>
        ))}
      </div>
    );
  }

  if (query.error) {
    return (
      <QueryError
        message="Could not load cost totals for this project."
        onRetry={() => void query.refetch()}
        test_id="project-cost-ribbon-error"
      />
    );
  }

  const kpi = query.data.windows[time_window];
  const unavailable = costCoverage(kpi).state === 'unavailable';

  // Null (not the API's own zero) makes formatMoney render an em dash for an unpriced window.
  // request_count and tokens aggregate the whole window, not just the priced blocks, so they are
  // never blanked here.
  const total_cost = unavailable ? null : kpi.total_cost;
  const llm_cost = unavailable ? null : kpi.llm_cost;
  const harness_cost = unavailable ? null : kpi.harness_cost;
  const recoverable_cost = unavailable ? null : kpi.recoverable_cost;
  const total_cost_value = parseMoney(kpi.total_cost);

  return (
    <TooltipProvider delayDuration={150}>
      <div className={RIBBON}>
        <RibbonCell
          test_id="project-cost-queries"
          label="Queries"
          value={formatCount(kpi.request_count)}
          hint={`${formatTokens(kpi.tokens)} tokens billed`}
        />
        <RibbonCell
          test_id="project-cost-total"
          label="Total spend"
          value={formatMoney(total_cost)}
          hint={`${formatCount(kpi.block_count)} blocks · ${formatMoney(recoverable_cost)} recoverable`}
          kpi={kpi}
        />
        <RibbonCell
          test_id="project-cost-model"
          label="Model tokens"
          value={formatMoney(llm_cost)}
          color={COST_SPLIT.llm_cost.color}
          hint={`${formatShare(parseMoney(kpi.llm_cost), total_cost_value)} of spend · ${formatTokens(kpi.tokens)} tokens`}
          kpi={kpi}
        />
        <RibbonCell
          test_id="project-cost-harness"
          label="Harness & compute"
          value={formatMoney(harness_cost)}
          color={COST_SPLIT.harness_cost.color}
          hint={`${formatShare(parseMoney(kpi.harness_cost), total_cost_value)} of spend · orchestration, retrieval, queueing`}
          kpi={kpi}
        />
        <RibbonCell
          test_id="project-cost-per-query"
          label="Cost per query"
          value={formatMoney(kpi.per_costed_request_cost)}
          hint={`${formatMoney(kpi.per_block_cost)} per block`}
          kpi={kpi}
        />
      </div>
    </TooltipProvider>
  );
}
