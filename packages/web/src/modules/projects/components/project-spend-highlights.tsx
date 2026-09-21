import { useQuery } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';

import type { MetricsBlock, MetricsBlocks, MetricsWindow } from '@canyonos/api/metrics';
import type { RequestList, RequestListItem } from '@canyonos/api/requests';

import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { cn } from '@repo/ui/utils';
import { apiCall, forgeAuthApi } from '@/api';
import { QueryError } from '@/modules/core/components/QueryError';
import {
  AnalyzeButton,
  AnalyzePreviewNote,
} from '@/modules/projects/components/project-analyze-button';
import { ProjectBlockDrawer } from '@/modules/projects/components/project-block-drawer';
import { costCoverage } from '@/modules/projects/components/project-cost-ribbon';
import { ProjectQueryDrawer } from '@/modules/projects/components/project-query-drawer';
import {
  formatMoney,
  formatMoneyValue,
  formatMultiple,
  formatQueryCost,
  formatShare,
  parseMoney,
  shortRequestId,
} from '@/modules/projects/projects.format';
import { projectKpisQueryOptions } from '@/modules/projects/projects.queries';
import { dashboardPollInterval, projectQueryKeys } from '@/modules/projects/projects.query-cache';
import type { SelectedBlock } from '@/modules/projects/components/project-block-drawer';

const MISSING = '—';

// One row is all this needs: the listing sorts by cost, so the dearest query is the first item.
const DEAREST_QUERY_PAGE = { limit: 1, offset: 0, sort: 'total_cost', order: 'desc' } as const;

interface ProjectSpendHighlightsProps {
  readonly project_id: string;
  readonly time_window: MetricsWindow;
}

const COST_UNAVAILABLE_HINT = 'Cost data is unavailable for this window.';

// blocks_query zeroes out the same way an unpriced KPI window does, so this tile needs the same
// "$0.00 reads as free" guard as the ribbon.
function agentSpendHint(
  agent: MetricsBlock | undefined,
  window_total: number,
  unavailable: boolean
): string {
  if (!agent) return 'Nothing has billed in this window.';
  if (unavailable) return COST_UNAVAILABLE_HINT;
  return `${formatMoney(agent.cost)} · ${formatShare(parseMoney(agent.cost), window_total)} of spend in this window`;
}

function queryCostHint(
  request: RequestListItem | undefined,
  average_query_cost: number | null,
  unavailable: boolean
): string {
  if (!request) return 'No queries have billed yet.';
  if (unavailable) return COST_UNAVAILABLE_HINT;
  if (average_query_cost === null || average_query_cost === 0) {
    return `${formatQueryCost(request.total_cost)} · no average to compare against yet`;
  }
  const multiple = parseMoney(request.total_cost) / average_query_cost;
  return `${formatQueryCost(request.total_cost)} · ${formatMultiple(multiple)} the window average of ${formatMoneyValue(average_query_cost)}`;
}

/**
 * The two names the Overview opens on: where the money went, and which single query cost the most.
 *
 * Both are one row lifted out of a list the other tabs carry in full. Each tile opens the same drawer
 * its row would open from that list, so the Overview answers the follow-up question without first
 * making the reader find the row.
 */
export function ProjectSpendHighlights({ project_id, time_window }: ProjectSpendHighlightsProps) {
  const [selected_block, setSelectedBlock] = useState<SelectedBlock | null>(null);
  const [selected_request, setSelectedRequest] = useState<RequestListItem | null>(null);
  const tiles_ref = useRef<HTMLDivElement>(null);
  // One note for both tiles, so each pill can say why it cannot act yet.
  const preview_id = useId();
  const tileRef = (test_id: string) => () =>
    tiles_ref.current?.querySelector<HTMLElement>(`[data-testid="${test_id}"]`) ?? null;
  const request_filters = { time_window } as const;

  const blocks_query = useQuery({
    queryKey: projectQueryKeys.metricsBlocks(project_id, time_window),
    queryFn: () =>
      apiCall<MetricsBlocks>(() =>
        forgeAuthApi.projects[project_id]!.metrics.blocks.get({ $query: { time_window } })
      ),
    retry: false,
    refetchInterval: dashboardPollInterval,
  });
  const kpis_query = useQuery(projectKpisQueryOptions(project_id));
  const dearest_query = useQuery({
    queryKey: projectQueryKeys.requests(project_id, DEAREST_QUERY_PAGE, request_filters),
    queryFn: () =>
      apiCall<RequestList>(() =>
        forgeAuthApi.projects[project_id]!.requests.get({
          $query: { ...DEAREST_QUERY_PAGE, time_window },
        })
      ),
    retry: false,
    refetchInterval: dashboardPollInterval,
  });

  if (blocks_query.isPending || kpis_query.isPending || dearest_query.isPending) {
    return (
      <div className={GRID} aria-busy data-testid="project-spend-highlights-loading">
        {['agent', 'query'].map((key) => (
          <div key={key} className={CELL}>
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-3 w-48" />
          </div>
        ))}
      </div>
    );
  }

  if (blocks_query.error || kpis_query.error || dearest_query.error) {
    return (
      <QueryError
        message="Could not load spend highlights."
        onRetry={() => {
          void Promise.all([blocks_query.refetch(), kpis_query.refetch(), dearest_query.refetch()]);
        }}
        test_id="project-spend-highlights-error"
      />
    );
  }

  const window_total = parseMoney(blocks_query.data.total_cost);
  // Dearest first, the same order the Per-Agent list reads in.
  const dearest_agent = blocks_query.data.blocks.toSorted(
    (left, right) => parseMoney(right.cost) - parseMoney(left.cost)
  )[0];

  const kpi = kpis_query.data.windows[time_window];
  const unavailable = costCoverage(kpi).state === 'unavailable';
  const average_query_cost =
    kpi.request_count > 0 ? parseMoney(kpi.total_cost) / kpi.request_count : null;
  const dearest_request = dearest_query.data.items[0];

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="project-spend-highlights">
      <div className={GRID} ref={tiles_ref}>
        <HighlightTile
          label="Most expensive agent"
          value={!dearest_agent || unavailable ? MISSING : dearest_agent.label}
          hint={agentSpendHint(dearest_agent, window_total, unavailable)}
          analyze_subject={dearest_agent?.label ?? null}
          preview_id={preview_id}
          analyze_test_id="project-highlight-agent-analyze"
          opens="its metrics"
          onOpen={
            dearest_agent
              ? () =>
                  setSelectedBlock({ agent_id: dearest_agent.agent_id, label: dearest_agent.label })
              : null
          }
          test_id="project-highlight-agent"
        />
        <HighlightTile
          label="Most expensive query"
          value={
            !dearest_request || unavailable ? MISSING : shortRequestId(dearest_request.session_id)
          }
          hint={queryCostHint(dearest_request, average_query_cost, unavailable)}
          analyze_subject={
            dearest_request ? `query ${shortRequestId(dearest_request.session_id)}` : null
          }
          preview_id={preview_id}
          analyze_test_id="project-highlight-query-analyze"
          opens="its trace"
          onOpen={dearest_request ? () => setSelectedRequest(dearest_request) : null}
          test_id="project-highlight-query"
        />
      </div>

      <p className="text-muted-foreground px-3 text-[0.71875rem]">
        Both highlights are scoped to the selected window.
      </p>

      {dearest_agent || dearest_request ? <AnalyzePreviewNote id={preview_id} /> : null}

      <ProjectBlockDrawer
        project_id={project_id}
        block={selected_block}
        onSelect={setSelectedBlock}
        returnFocusTo={tileRef('project-highlight-agent')}
      />
      <ProjectQueryDrawer
        project_id={project_id}
        request={selected_request}
        onClose={() => setSelectedRequest(null)}
        returnFocusTo={tileRef('project-highlight-query')}
      />
    </div>
  );
}

const GRID =
  'border-border bg-card grid min-w-0 overflow-hidden rounded-[1.125rem] border shadow-xs sm:grid-cols-2';

const CELL = 'flex min-w-0 flex-col gap-1.5 px-[1.0625rem] py-[0.9375rem]';

function HighlightTile({
  label,
  value,
  hint,
  opens,
  onOpen,
  test_id,
  analyze_subject,
  preview_id,
  analyze_test_id,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint: string;
  /** What the drawer shows, read as "Open …" by the screen reader. */
  readonly opens: string;
  readonly onOpen: (() => void) | null;
  readonly test_id: string;
  /** What the button would analyse, or null when the tile has nothing to name. */
  readonly analyze_subject: string | null;
  readonly preview_id: string;
  readonly analyze_test_id: string;
}) {
  return (
    // The tile is the cell and its click target is a transparent overlay inside it, so the
    // Analyze pill can sit beside the name without nesting one button in another.
    <div
      className={cn(
        CELL,
        'border-border/70 relative transition-colors not-first:border-t sm:not-first:border-t-0 sm:not-first:border-l',
        'has-[button:enabled]:hover:bg-muted/50',
        'has-[button:focus-visible]:ring-ring has-[button:focus-visible]:ring-2 has-[button:focus-visible]:ring-inset'
      )}
    >
      <button
        type="button"
        disabled={onOpen === null}
        onClick={() => onOpen?.()}
        title={`${label}: ${value}`}
        aria-label={onOpen === null ? `${label}: ${value}` : `${label}: ${value}. Open ${opens}.`}
        data-testid={test_id}
        className="absolute inset-0 z-[1] outline-none disabled:cursor-default"
      />
      <span className="text-muted-foreground text-[0.65625rem] font-semibold tracking-[0.05em] uppercase">
        {label}
      </span>
      <span className="flex min-w-0 items-center gap-2">
        <span className="text-foreground min-w-0 truncate font-mono text-[1.25rem] leading-none font-semibold tracking-[-0.02em]">
          {value}
        </span>
        {analyze_subject === null ? null : (
          <AnalyzeButton
            subject={analyze_subject}
            describedBy={preview_id}
            test_id={analyze_test_id}
          />
        )}
      </span>
      <span className="text-muted-foreground text-[0.71875rem] leading-snug text-pretty">
        {hint}
      </span>
    </div>
  );
}
