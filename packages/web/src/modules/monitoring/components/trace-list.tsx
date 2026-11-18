// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { ArrowUpRightIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { MonitoringTrace, MonitoringTraceSpan } from '@canyonos/api/monitoring';

import { Card } from '@repo/ui/shadcn/card';
import { Collapsible, CollapsibleContent } from '@repo/ui/shadcn/collapsible';
import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { EmptyState } from '@/modules/core/components/EmptyState';
import { QueryError } from '@/modules/core/components/QueryError';
import { Payload } from '@/modules/monitoring/components/payload';
import { RowTrigger } from '@/modules/monitoring/components/row-trigger';
import { formatCost, formatTokens } from '@/modules/monitoring/monitoring.format';
import { tracesQueryOptions } from '@/modules/monitoring/monitoring.queries';
import { ProjectQueryDrawer } from '@/modules/projects/components/project-query-drawer';
import { formatQueryCost } from '@/modules/projects/projects.format';
import { COST_SPLIT } from '@/modules/projects/projects.metrics';
import type { RangeSelection } from '@/modules/core/time-range';
import type { OpenedQuery } from '@/modules/projects/components/project-query-drawer';

const TRACE_LIMIT = 200;

const route = getRouteApi('/_authenticated/projects/$project_id/monitoring');

type SpanLlm = NonNullable<MonitoringTraceSpan['llm']>;

const formatDuration = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;

const scrollToRow = (row: HTMLTableRowElement | null) => row?.scrollIntoView({ block: 'center' });

function spanBarColor(span: MonitoringTraceSpan) {
  if (span.failed) return 'var(--destructive)';
  return span.llm ? COST_SPLIT.llm_cost.color : COST_SPLIT.harness_cost.color;
}

interface TraceListProps {
  readonly project_id: string;
  readonly range: RangeSelection;
}

export function TraceList({ project_id, range }: TraceListProps) {
  const [opened, setOpened] = useState<OpenedQuery | null>(null);
  const opened_trace_id = useRef<string | null>(null);

  return (
    <>
      <TraceTable
        project_id={project_id}
        range={range}
        onOpenDetails={(query) => {
          opened_trace_id.current = query.session_id;
          setOpened(query);
        }}
      />
      {/* Outside the table's loading and error branches, so a refetch behind it never closes it. */}
      <ProjectQueryDrawer
        project_id={project_id}
        opened={opened}
        onClose={() => setOpened(null)}
        returnFocusTo={() =>
          document.querySelector<HTMLElement>(
            `[data-testid="trace-row-details-${opened_trace_id.current}"]`
          )
        }
      />
    </>
  );
}

function TraceTable({
  project_id,
  range,
  onOpenDetails,
}: TraceListProps & { readonly onOpenDetails: (query: OpenedQuery) => void }) {
  const { trace: focused_trace_id } = route.useSearch();
  const query = useQuery(tracesQueryOptions(project_id, { range, limit: TRACE_LIMIT }));

  if (query.error) {
    return (
      <QueryError
        message="Could not load traces."
        onRetry={() => void query.refetch()}
        test_id="traces-error"
      />
    );
  }

  if (query.isPending) {
    return <Skeleton className="h-96 w-full rounded-lg" />;
  }

  const { traces, from, to } = query.data;

  if (traces.length === 0) {
    return <EmptyState test_id="traces-empty">No traces recorded in this window.</EmptyState>;
  }

  return (
    <Card className="min-w-0 overflow-x-auto" data-testid="traces-table">
      <table className="w-full border-collapse text-left font-mono text-xs">
        <thead className="text-muted-foreground border-border/50 border-b whitespace-nowrap">
          <tr className="divide-border/40 divide-x">
            <th className="w-44 px-4 py-2 font-normal">time</th>
            <th className="px-2 py-2 font-normal">trace</th>
            <th className="w-48 px-2 py-2 font-normal">agents</th>
            <th className="w-16 px-2 py-2 text-right font-normal">spans</th>
            <th className="w-20 px-2 py-2 text-right font-normal">llm calls</th>
            <th className="w-24 px-2 py-2 text-right font-normal">total cost</th>
            <th className="w-20 px-2 py-2 text-right font-normal">duration</th>
          </tr>
        </thead>
        {traces.map((trace, index) => (
          <TraceRow
            key={trace.trace_id}
            trace={trace}
            index={index}
            focused={trace.trace_id === focused_trace_id}
            onOpenDetails={(trace_id) =>
              onOpenDetails({ session_id: trace_id, range: { from, to } })
            }
          />
        ))}
      </table>
    </Card>
  );
}

// The trace named in the URL opens on arrival and collapsing it drops it from the URL; every other
// row opens and closes on its own.
function TraceRow({
  trace,
  index,
  focused,
  onOpenDetails,
}: {
  readonly trace: MonitoringTrace;
  readonly index: number;
  readonly focused: boolean;
  readonly onOpenDetails: (trace_id: string) => void;
}) {
  const navigate = route.useNavigate();
  const llm_calls = trace.spans.filter((span) => span.llm !== null).length;
  const tone = trace.failed ? 'text-destructive' : 'text-muted-foreground';

  return (
    <Collapsible
      asChild
      defaultOpen={focused}
      onOpenChange={(open) => {
        if (open || !focused) return;
        void navigate({ search: (prev) => ({ ...prev, trace: undefined }), replace: true });
      }}
    >
      <tbody className="border-border/50 border-b last:border-b-0">
        <tr
          ref={focused ? scrollToRow : undefined}
          className={`${tone} divide-border/40 hover:bg-foreground/[0.03] has-[:focus-visible]:bg-foreground/[0.03] relative cursor-pointer divide-x`}
        >
          <td className="px-4 py-2 align-top whitespace-nowrap">{trace.at}</td>
          <td
            className={`truncate px-2 py-2 align-top ${trace.failed ? 'text-destructive' : 'text-foreground'}`}
          >
            <RowTrigger data-testid={`trace-row-toggle-${index}`}>{trace.name}</RowTrigger>
          </td>
          <td className="truncate px-2 py-2 align-top">
            {trace.agents.length === 0 ? '—' : trace.agents.join(', ')}
          </td>
          <td className="px-2 py-2 text-right align-top whitespace-nowrap">{trace.span_count}</td>
          <td
            className="px-2 py-2 text-right align-top whitespace-nowrap"
            data-testid={`trace-row-llm-${index}`}
          >
            {llm_calls === 0 ? '—' : llm_calls}
          </td>
          <td
            className="px-2 py-2 text-right align-top whitespace-nowrap"
            data-testid={`trace-row-cost-${index}`}
          >
            {trace.total_cost === null ? '—' : formatQueryCost(String(trace.total_cost))}
          </td>
          <td className="px-2 py-2 text-right align-top whitespace-nowrap">
            {formatDuration(trace.duration_ms)}
          </td>
        </tr>
        <CollapsibleContent asChild>
          <tr data-testid={`trace-spans-${index}`}>
            <td colSpan={7} className="bg-foreground/[0.02] px-4 py-3">
              <div className="mb-3 flex items-center gap-3">
                <span className="text-muted-foreground">trace_id {trace.trace_id}</span>
                <button
                  type="button"
                  className="text-link inline-flex items-center gap-1"
                  onClick={() => onOpenDetails(trace.trace_id)}
                  data-testid={`trace-row-details-${trace.trace_id}`}
                >
                  Query details
                  <ArrowUpRightIcon className="size-3" aria-hidden />
                </button>
              </div>
              <table className="w-full border-collapse">
                {trace.spans.map((span) => (
                  <SpanRow key={span.span_id} span={span} total_ms={trace.duration_ms} />
                ))}
              </table>
            </td>
          </tr>
        </CollapsibleContent>
      </tbody>
    </Collapsible>
  );
}

function SpanRow({
  span,
  total_ms,
}: {
  readonly span: MonitoringTraceSpan;
  readonly total_ms: number;
}) {
  if (span.llm) return <LlmSpanRow span={span} llm={span.llm} total_ms={total_ms} />;

  return (
    <tbody>
      <tr className="align-top">
        <SpanCells span={span} total_ms={total_ms}>
          <SpanLabel span={span} />
        </SpanCells>
      </tr>
    </tbody>
  );
}

function LlmSpanRow({
  span,
  llm,
  total_ms,
}: {
  readonly span: MonitoringTraceSpan;
  readonly llm: SpanLlm;
  readonly total_ms: number;
}) {
  return (
    <Collapsible asChild>
      <tbody>
        <tr className="hover:bg-foreground/[0.03] has-[:focus-visible]:bg-foreground/[0.03] relative cursor-pointer align-top">
          <SpanCells span={span} total_ms={total_ms}>
            <RowTrigger data-testid={`span-row-toggle-${span.span_id}`}>
              <SpanLabel span={span} />
            </RowTrigger>
          </SpanCells>
        </tr>
        <CollapsibleContent asChild>
          <tr data-testid={`span-llm-${span.span_id}`}>
            <td colSpan={4} className="pt-1 pb-3">
              <div className="text-muted-foreground mb-3">
                {llm.model ?? 'unknown model'} · {formatTokens(llm.input_tokens)} in ·{' '}
                {formatTokens(llm.output_tokens)} out · {formatCost(llm.cost)}
              </div>
              {llm.input === null ? null : <Payload label="input" value={llm.input} />}
              {llm.output === null ? null : <Payload label="output" value={llm.output} />}
            </td>
          </tr>
        </CollapsibleContent>
      </tbody>
    </Collapsible>
  );
}

function SpanLabel({ span }: { readonly span: MonitoringTraceSpan }) {
  return (
    <>
      {span.name}
      {span.llm ? (
        <span className="text-muted-foreground"> · {span.llm.model ?? 'LLM'}</span>
      ) : null}
      {span.status_message === null ? null : (
        <span className="text-muted-foreground"> — {span.status_message}</span>
      )}
    </>
  );
}

function SpanCells({
  span,
  total_ms,
  children,
}: {
  readonly span: MonitoringTraceSpan;
  readonly total_ms: number;
  readonly children: ReactNode;
}) {
  const scale = total_ms > 0 ? 100 / total_ms : 0;

  return (
    <>
      <td
        className={`w-1/3 truncate py-1 pr-3 ${span.failed ? 'text-destructive' : 'text-foreground'}`}
      >
        {children}
      </td>
      <td className="text-muted-foreground w-36 truncate py-1 pr-3">{span.agent ?? '—'}</td>
      <td className="py-1 pr-3">
        <div className="bg-foreground/[0.05] relative h-3 w-full rounded-sm">
          <div
            className="absolute h-3 min-w-px rounded-sm"
            style={{
              left: `${span.offset_ms * scale}%`,
              width: `${span.duration_ms * scale}%`,
              backgroundColor: spanBarColor(span),
            }}
          />
        </div>
      </td>
      <td className="text-muted-foreground w-20 py-1 text-right whitespace-nowrap">
        {formatDuration(span.duration_ms)}
      </td>
    </>
  );
}
