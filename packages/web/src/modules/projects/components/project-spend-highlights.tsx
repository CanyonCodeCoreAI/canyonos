// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';

import type { MetricsBlock } from '@canyonos/api/metrics';
import type { RequestListItem } from '@canyonos/api/requests';

import { Card } from '@repo/ui/shadcn/card';
import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { cn } from '@repo/ui/utils';
import { QueryError } from '@/modules/core/components/QueryError';
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
import {
  projectBlocksQueryOptions,
  projectKpisQueryOptions,
  projectRequestsQueryOptions,
} from '@/modules/projects/projects.queries';
import type { RangeSelection } from '@/modules/core/time-range';
import type { SelectedBlock } from '@/modules/projects/components/project-block-drawer';
import type { OpenedQuery } from '@/modules/projects/components/project-query-drawer';

const MISSING = '—';

// One row is all this needs: the listing sorts by cost, so the dearest query is the first item.
const DEAREST_QUERY_PAGE = { limit: 1, offset: 0, sort: 'total_cost', order: 'desc' } as const;

interface ProjectSpendHighlightsProps {
  readonly project_id: string;
  readonly range: RangeSelection;
}

const COST_UNAVAILABLE_HINT = 'Cost data is unavailable for this range.';

// blocks_query zeroes out the same way an unpriced KPI range does, so this tile needs the same
// "$0.00 reads as free" guard as the ribbon.
function agentSpendHint(
  agent: MetricsBlock | undefined,
  range_total: number,
  unavailable: boolean
): string {
  if (!agent) return 'Nothing has billed in this range.';
  if (unavailable) return COST_UNAVAILABLE_HINT;
  return `${formatMoney(agent.cost)} · ${formatShare(parseMoney(agent.cost), range_total)} of spend in this range`;
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
  return `${formatQueryCost(request.total_cost)} · ${formatMultiple(multiple)} the range average of ${formatMoneyValue(average_query_cost)}`;
}

/**
 * The two names the Overview opens on: where the money went, and which single query cost the most.
 *
 * Both are one row lifted out of a list the other tabs carry in full. Each tile opens the same drawer
 * its row would open from that list, so the Overview answers the follow-up question without first
 * making the reader find the row.
 */
export function ProjectSpendHighlights({ project_id, range }: ProjectSpendHighlightsProps) {
  const [selected_block, setSelectedBlock] = useState<SelectedBlock | null>(null);
  const [opened_query, setOpenedQuery] = useState<OpenedQuery | null>(null);
  const tiles_ref = useRef<HTMLDivElement>(null);
  const tileRef = (test_id: string) => () =>
    tiles_ref.current?.querySelector<HTMLElement>(`[data-testid="${test_id}"]`) ?? null;

  const blocks_query = useQuery(projectBlocksQueryOptions(project_id, { range }));
  const kpis_query = useQuery(projectKpisQueryOptions(project_id, { range }));
  const dearest_query = useQuery(
    projectRequestsQueryOptions(project_id, { range, ...DEAREST_QUERY_PAGE })
  );

  if (blocks_query.isPending || kpis_query.isPending || dearest_query.isPending) {
    return (
      <Card className={GRID} aria-busy data-testid="project-spend-highlights-loading">
        {['agent', 'query'].map((key) => (
          <div key={key} className={CELL}>
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-3 w-48" />
          </div>
        ))}
      </Card>
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

  const range_total = parseMoney(blocks_query.data.total_cost);
  // Dearest first, the same order the Per-Agent list reads in.
  const dearest_agent = blocks_query.data.blocks.toSorted(
    (left, right) => parseMoney(right.cost) - parseMoney(left.cost)
  )[0];

  const kpi = kpis_query.data;
  const unavailable = costCoverage(kpi).state === 'unavailable';
  const average_query_cost =
    kpi.request_count > 0 ? parseMoney(kpi.total_cost) / kpi.request_count : null;
  const { from, to, items } = dearest_query.data;
  const dearest_request = items[0];

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="project-spend-highlights">
      <Card className={GRID} ref={tiles_ref}>
        <HighlightTile
          label="Most expensive agent"
          value={!dearest_agent || unavailable ? MISSING : dearest_agent.label}
          hint={agentSpendHint(dearest_agent, range_total, unavailable)}
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
          opens="its trace"
          onOpen={
            dearest_request
              ? () => setOpenedQuery({ request: dearest_request, range: { from, to } })
              : null
          }
          test_id="project-highlight-query"
        />
      </Card>

      <p className="text-muted-foreground px-3 text-[0.71875rem]">
        Both highlights are scoped to the selected range.
      </p>

      <ProjectBlockDrawer
        project_id={project_id}
        block={selected_block}
        onSelect={setSelectedBlock}
        returnFocusTo={tileRef('project-highlight-agent')}
      />
      <ProjectQueryDrawer
        project_id={project_id}
        opened={opened_query}
        onClose={() => setOpenedQuery(null)}
        returnFocusTo={tileRef('project-highlight-query')}
      />
    </div>
  );
}

const GRID = 'grid min-w-0 overflow-hidden sm:grid-cols-2';

const CELL = 'flex min-w-0 flex-col gap-1.5 px-[1.0625rem] py-[0.9375rem]';

function HighlightTile({
  label,
  value,
  hint,
  opens,
  onOpen,
  test_id,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint: string;
  /** What the drawer shows, read as "Open …" by the screen reader. */
  readonly opens: string;
  readonly onOpen: (() => void) | null;
  readonly test_id: string;
}) {
  return (
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
      <span className="text-foreground min-w-0 truncate font-mono text-[1.25rem] leading-tight font-semibold tracking-[-0.02em]">
        {value}
      </span>
      <span className="text-muted-foreground text-[0.71875rem] leading-snug text-pretty">
        {hint}
      </span>
    </div>
  );
}
