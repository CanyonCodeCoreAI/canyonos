import { useQuery } from '@tanstack/react-query';
import { ArrowRightIcon, SparklesIcon } from 'lucide-react';
import { useId, useState } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';

import type {
  DistributionMetric,
  DistributionStats,
  MetricsAgentDetails,
  MetricsBlocks,
  MetricsWindow,
} from '@canyonos/api/metrics';

import { CdfChart } from '@repo/ui/components/charts/cdf-chart';
import { SectionLabel } from '@repo/ui/components/section-label';
import { StatCard } from '@repo/ui/components/stat-card';
import { TimeRangeToggle } from '@repo/ui/components/time-range-toggle';
import { Badge } from '@repo/ui/shadcn/badge';
import { Button } from '@repo/ui/shadcn/button';
import { Input } from '@repo/ui/shadcn/input';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@repo/ui/shadcn/sheet';
import { Skeleton } from '@repo/ui/shadcn/skeleton';
import type { CdfMarker } from '@repo/ui/components/charts/cdf-chart';
import { apiCall, ApiResponseError, forgeAuthApi } from '@/api';
import { EmptyState } from '@/modules/core/components/EmptyState';
import { QueryError } from '@/modules/core/components/QueryError';
import { CostTimeseriesChart } from '@/modules/projects/components/project-cost-timeseries';
import {
  formatCount,
  formatDurationMs,
  formatMoney,
  formatMoneyValue,
  formatRate,
  formatShare,
  formatTokens,
  parseMoney,
} from '@/modules/projects/projects.format';
import {
  COST_SPLIT,
  DISTRIBUTION_METRIC_FORMATTER,
  DISTRIBUTION_METRIC_OPTIONS,
  DISTRIBUTION_METRIC_TITLE,
  distributionCdfPoints,
  isDistributionMetric,
  LOCAL_TIME_ZONE,
} from '@/modules/projects/projects.metrics';
import { projectQueryKeys } from '@/modules/projects/projects.query-cache';
import type { CostSplitSide } from '@/modules/projects/projects.metrics';

const TEST_ID = 'project-block-drawer';
const MISSING = '—';

// The agent route is fixed to 30 days, so the table beside it reads the same range.
const DRAWER_WINDOW: MetricsWindow = '30d';
const WINDOW_LABEL = 'Last 30 days';

const agentQuery = (project_id: string, agent_id: string) => ({
  queryKey: projectQueryKeys.metricsAgent(project_id, agent_id, LOCAL_TIME_ZONE),
  queryFn: () =>
    apiCall<MetricsAgentDetails>(() =>
      forgeAuthApi.projects[project_id]!.metrics.agents[agent_id]!.get({
        // The zone the cost-over-time buckets are cut on, so its day boundaries match the project
        // timeline's rather than falling on UTC midnights.
        $query: { time_zone: LOCAL_TIME_ZONE },
      })
    ),
  retry: false,
});

const blocksQuery = (project_id: string, time_window: MetricsWindow) => ({
  queryKey: projectQueryKeys.metricsBlocks(project_id, time_window),
  queryFn: () =>
    apiCall<MetricsBlocks>(() =>
      forgeAuthApi.projects[project_id]!.metrics.blocks.get({ $query: { time_window } })
    ),
  retry: false,
});

const RETRY_ALERT = 0.05;

const ASSISTANT_SUGGESTIONS = [
  'Why is this block expensive?',
  'What can I safely change?',
] as const;

const PERCENTILE_MARKERS = [
  { id: 'p50', label: 'p50', share: 50 },
  { id: 'p95', label: 'p95', share: 95 },
] as const satisfies readonly {
  id: keyof Pick<DistributionStats, 'p50' | 'p95'>;
  label: string;
  share: number;
}[];

// `verb` reads the p95 aloud in the metric's own terms: "95% cost ≤ …" / "95% finish in ≤ …".
const METRIC_COPY: Record<DistributionMetric, { readonly verb: string; readonly empty: string }> = {
  cost_per_request: {
    verb: 'cost',
    empty: 'No queries to bin for this block yet.',
  },
  tokens_per_request: {
    verb: 'use',
    empty: 'No queries to bin for this block yet.',
  },
  latency: {
    verb: 'finish in',
    empty: 'No queries finished in this block yet, so there is nothing to time.',
  },
};

// The name travels with the id so the header can name the block before its own request lands, and
// when that request 404s.
export interface SelectedBlock {
  readonly agent_id: string;
  readonly label: string;
}

interface ProjectBlockDrawerProps {
  readonly project_id: string;
  /** `null` closes the drawer. */
  readonly block: SelectedBlock | null;
  readonly onSelect: (block: SelectedBlock | null) => void;
  /** Focused again on close; without it focus falls to the document body. */
  readonly returnFocusTo?: () => HTMLElement | null;
}

/** The selected block's trailing-30-day metrics, whatever range the dashboard shows. */
export function ProjectBlockDrawer({
  project_id,
  block,
  onSelect,
  returnFocusTo,
}: ProjectBlockDrawerProps) {
  // Held through the close animation, which still runs after `block` is null.
  const [shown_block, setShownBlock] = useState(block);
  if (block !== null && block !== shown_block) setShownBlock(block);

  return (
    <Sheet
      open={block !== null}
      onOpenChange={(open) => {
        if (!open) onSelect(null);
      }}
    >
      {/* Full width on a phone, a readable column from `sm` up, and never past the viewport. */}
      <SheetContent
        side="right"
        className="w-full gap-0 p-0 sm:max-w-[35rem]"
        tabIndex={-1}
        // Default focus lands on the first block row, and the Enter that opened the drawer would
        // then activate it. Focus the panel instead.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
        onCloseAutoFocus={(event) => {
          const opener = returnFocusTo?.();
          if (!opener) return;
          event.preventDefault();
          opener.focus();
        }}
        data-testid={TEST_ID}
      >
        {shown_block === null ? null : (
          <BlockDrawerBody project_id={project_id} block={shown_block} />
        )}
      </SheetContent>
    </Sheet>
  );
}

function BlockDrawerBody({
  project_id,
  block,
}: {
  readonly project_id: string;
  readonly block: SelectedBlock;
}) {
  const agent_id = block.agent_id;
  // Independent reads: either can fail or arrive first, so each renders its own states.
  const agent_query = useQuery(agentQuery(project_id, agent_id));
  const blocks_query = useQuery(blocksQuery(project_id, DRAWER_WINDOW));

  const details = agent_query.data;
  // The agent this drawer describes is named rather than addressed: the opening id can be one
  // replica, while the project block rollup infers the models used across every replica.
  const label = details?.label ?? block.label;
  // The summary aggregates an agent across its models and replicas, so it carries no `model` of its
  // own; the project block rollup does.
  const models = blocks_query.data ? agentModels(blocks_query.data, label) : undefined;
  const side = splitSide(models, details);
  const replicas = details?.agent.replica_count ?? 0;

  return (
    <>
      <SheetHeader className="border-border/70 shrink-0 gap-1.5 border-b px-5 py-4 pr-14">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className="size-2 shrink-0 rounded-sm"
            style={{ backgroundColor: side ? COST_SPLIT[side].color : 'var(--muted-foreground)' }}
            aria-hidden
          />
          <SheetTitle className="min-w-0 truncate font-mono text-[0.9375rem]">{label}</SheetTitle>
          {side ? (
            <Badge
              variant="secondary"
              className="shrink-0 font-mono text-[0.625rem] tracking-[0.06em] uppercase"
              data-testid={`${TEST_ID}-kind`}
            >
              {kindLabel(side, models ?? [])}
            </Badge>
          ) : null}
        </div>
        <SheetDescription>
          {WINDOW_LABEL} · this agent on its own, whatever range the dashboard is showing.
          {replicas > 1 ? ` Totalled across ${replicas} replicas.` : ''}
        </SheetDescription>
      </SheetHeader>
      <div
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-5"
        tabIndex={0}
        role="region"
        aria-label={`${label} metrics`}
      >
        <AgentSections query={agent_query} side={side} />
        <CostOverTimeSection query={agent_query} />
      </div>

      <AssistantFooter />
    </>
  );
}

// Rows group by (agent_id, model), so one agent spans a row per model per replica. Matched by name,
// because the agent this drawer describes is the name — every replica's models are its models.
function agentModels(blocks: MetricsBlocks, label: string): readonly string[] {
  const models = new Set<string>();
  for (const block of blocks.blocks) {
    if (block.label === label && block.model !== null) models.add(block.model);
  }
  return [...models];
}

// Without the project block rollup there are no models to read, so the side falls back to token cost — which
// agrees with the model field on every staging row, and beats dropping the badge entirely.
function splitSide(
  models: readonly string[] | undefined,
  details: MetricsAgentDetails | undefined
): CostSplitSide | null {
  if (models) return models.length > 0 ? 'llm_cost' : 'harness_cost';
  if (!details) return null;
  return Number(details.agent.llm_cost) > 0 ? 'llm_cost' : 'harness_cost';
}

function kindLabel(side: CostSplitSide, models: readonly string[]): string {
  const kind = COST_SPLIT[side].label;
  if (models.length === 0) return kind;
  return models.length === 1 ? `${kind} · ${models[0]}` : `${kind} · ${models.length} models`;
}

// A block the runtime never ran is not a failure to report.
function isMissingAgentMetrics(error: unknown): boolean {
  return error instanceof ApiResponseError && error.code === 'metrics.agent_not_found';
}

function AgentSections({
  query,
  side,
}: {
  readonly query: UseQueryResult<MetricsAgentDetails>;
  readonly side: CostSplitSide | null;
}) {
  if (query.isPending) {
    return (
      <div className="flex flex-col gap-4" aria-busy data-testid={`${TEST_ID}-loading`}>
        <div className="grid grid-cols-2 gap-2.5">
          {Array.from({ length: 8 }, (_cell, index) => (
            <Skeleton key={index} className="h-[3.375rem] rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-56 rounded-2xl" />
      </div>
    );
  }

  if (query.error) {
    return isMissingAgentMetrics(query.error) ? (
      <EmptyState size="section" test_id={`${TEST_ID}-empty`}>
        <p className="text-center text-pretty">
          No runtime data for this block in the last 30 days.
        </p>
      </EmptyState>
    ) : (
      <QueryError
        message="Could not load this block's metrics."
        onRetry={() => void query.refetch()}
        test_id={`${TEST_ID}-error`}
      />
    );
  }

  return (
    <>
      <BlockOverview details={query.data} />
      <PerQueryDistribution key={query.data.agent_id} details={query.data} side={side} />
    </>
  );
}

// Derived: the API ships no per-1K figure.
function costPer1kQueries(cost: number, request_count: number): string {
  return request_count > 0 ? formatMoneyValue((cost / request_count) * 1000) : MISSING;
}

function BlockOverview({ details }: { readonly details: MetricsAgentDetails }) {
  const { agent, project } = details;
  const cost = parseMoney(agent.cost);
  const project_cost = parseMoney(project.total_cost);
  const per_block_tokens = agent.block_count > 0 ? agent.token_count / agent.block_count : null;

  return (
    <section className="flex flex-col gap-2.5">
      <SectionLabel as="h3">Overview · {WINDOW_LABEL}</SectionLabel>
      <div className="grid grid-cols-2 gap-2.5" data-testid={`${TEST_ID}-overview`}>
        <StatCard
          size="compact"
          label="Cost"
          value={formatMoney(agent.cost)}
          hint={`${formatCount(agent.block_count)} blocks`}
        />
        <StatCard
          size="compact"
          label="Share of spend"
          value={formatShare(cost, project_cost)}
          hint={`of ${formatMoney(project.total_cost)}`}
        />
        <StatCard
          size="compact"
          label="Tokens"
          value={formatTokens(agent.token_count)}
          hint={`${formatTokens(per_block_tokens)} / block`}
        />
        <StatCard
          size="compact"
          label="Per 1K project queries"
          value={costPer1kQueries(cost, project.request_count)}
          hint={`over ${formatCount(project.request_count)} queries`}
        />
        <StatCard
          size="compact"
          label="p95 latency"
          value={formatDurationMs(agent.p95_latency_ms)}
          hint="per block"
        />
        <StatCard
          size="compact"
          tone={
            agent.retry_rate !== null && agent.retry_rate >= RETRY_ALERT ? 'warning' : 'default'
          }
          label="Retry rate"
          value={formatRate(agent.retry_rate)}
          hint={`${formatRate(agent.failed_rate)} failed`}
        />
        <StatCard size="compact" label="Cache hit" value={formatRate(agent.cache_hit_ratio)} />
        <StatCard
          size="compact"
          tone="danger"
          label="Recoverable"
          value={formatMoney(agent.recoverable_cost)}
          hint={`${formatShare(parseMoney(agent.recoverable_cost), cost)} of this block`}
        />
      </div>
      <p className="text-muted-foreground text-[0.8125rem] leading-relaxed text-pretty">
        Ran in {formatCount(agent.request_count)} of the project&apos;s{' '}
        {formatCount(project.request_count)} queries (
        {formatShare(agent.request_count, project.request_count)}).
      </p>
    </section>
  );
}

function PerQueryDistribution({
  details,
  side,
}: {
  readonly details: MetricsAgentDetails;
  readonly side: CostSplitSide | null;
}) {
  const [metric, setMetric] = useState<DistributionMetric>('cost_per_request');
  const distribution = details[metric];
  const format = DISTRIBUTION_METRIC_FORMATTER[metric];
  const copy = METRIC_COPY[metric];
  const color = COST_SPLIT[side ?? 'llm_cost'].color;

  const points = distributionCdfPoints(distribution);

  // Percentiles sit at a known share of the curve, so the marker's x is fixed and only its height
  // comes from the payload — no hunting for the bucket the value fell in.
  const markers: CdfMarker[] = [];
  for (const marker of PERCENTILE_MARKERS) {
    const percentile = distribution[marker.id];
    if (percentile === null) continue;
    markers.push({
      key: marker.id,
      share: marker.share,
      value: percentile,
      label: `${marker.label} ${format(percentile)}`,
    });
  }

  return (
    <section className="border-border/70 flex flex-col gap-2.5 border-t pt-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionLabel as="h3">{DISTRIBUTION_METRIC_TITLE[metric]} inside this block</SectionLabel>
        <TimeRangeToggle
          value={metric}
          onValueChange={(next) => {
            if (!isDistributionMetric(next)) return;
            setMetric(next);
          }}
          options={DISTRIBUTION_METRIC_OPTIONS}
          aria-label="Per-query distribution metric"
          data-testid={`${TEST_ID}-metric`}
        />
      </div>
      {points.length === 0 ? (
        <p className="text-muted-foreground text-[0.8125rem]" data-testid={`${TEST_ID}-histogram`}>
          {copy.empty}
        </p>
      ) : (
        <>
          <div className="h-56 w-full" data-testid={`${TEST_ID}-histogram`}>
            <CdfChart
              data={points}
              config={{ value: { label: 'Queries', color } }}
              markers={markers}
              valueFormatter={format}
              countFormatter={formatCount}
            />
          </div>
          <p className="text-muted-foreground text-xs">
            Mean {distribution.mean === null ? MISSING : format(distribution.mean)} per query ·{' '}
            {formatCount(distribution.request_count)} queries
            {distribution.p95 === null ? '' : ` · 95% ${copy.verb} ≤ ${format(distribution.p95)}`}.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * This agent's spend per day over the window.
 *
 * The same chart the project timeline draws, on this agent's slice of it, so a reader comparing the
 * two is comparing like with like. It rides on the agent payload rather than a fetch of its own,
 * which is why there is no separate error state: the sections above have already reported it.
 */
function CostOverTimeSection({ query }: { readonly query: UseQueryResult<MetricsAgentDetails> }) {
  return (
    <section className="border-border/70 flex flex-col gap-2.5 border-t pt-5">
      <SectionLabel as="h3">Cost over time · {WINDOW_LABEL}</SectionLabel>
      {query.isPending ? (
        <Skeleton
          className="h-72 w-full rounded-[1.125rem]"
          data-testid={`${TEST_ID}-cost-time-loading`}
        />
      ) : query.error ? null : (
        <AgentCostChart details={query.data} />
      )}
    </section>
  );
}

/**
 * The chart, and the two different nothings it can be asked to draw.
 *
 * An agent that ran nothing has an all-zero series. An API that predates the series has no field at
 * all — the response type cannot express that, but a client deployed ahead of its API meets it, so
 * the two are told apart here rather than both reading as "ran nothing".
 */
function AgentCostChart({ details }: { readonly details: MetricsAgentDetails }) {
  const series = details.timeseries as MetricsAgentDetails['timeseries'] | undefined;

  return (
    <CostTimeseriesChart
      timeseries={series}
      test_id_prefix={`${TEST_ID}-cost-time`}
      empty_message={
        series === undefined
          ? 'This project’s API does not report per-agent cost over time yet.'
          : 'This agent ran nothing in the last 30 days, so there is no spend to plot.'
      }
    />
  );
}

function AssistantFooter() {
  const hint_id = useId();

  return (
    <SheetFooter
      className="border-border/70 bg-muted/30 shrink-0 gap-2.5 border-t px-5 py-4"
      data-testid={`${TEST_ID}-assistant`}
    >
      <div className="flex flex-wrap gap-2">
        {ASSISTANT_SUGGESTIONS.map((suggestion) => (
          <Button
            key={suggestion}
            type="button"
            variant="outline"
            size="sm"
            className="h-8 rounded-full text-xs font-medium"
            disabled
            aria-describedby={hint_id}
          >
            {suggestion}
          </Button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <SparklesIcon className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <Input
          disabled
          placeholder="Ask about what you're looking at…"
          aria-label="Ask about this block"
          aria-describedby={hint_id}
          className="h-9 text-[0.8125rem]"
        />
        <Button
          type="button"
          size="icon"
          className="size-9 shrink-0"
          disabled
          aria-label="Ask"
          aria-describedby={hint_id}
        >
          <ArrowRightIcon />
        </Button>
      </div>
      <p id={hint_id} className="text-muted-foreground text-[0.71875rem]">
        Asking about a block is not available yet — these controls are a preview.
      </p>
    </SheetFooter>
  );
}
