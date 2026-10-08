import { useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { ChevronDownIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import type { MetricsWindow } from '@canyonos/api/metrics';
import type {
  MonitoringTrace,
  MonitoringTraceSpan,
  MonitoringTracesResponse,
} from '@canyonos/api/monitoring';

import { Collapsible, CollapsibleContent } from '@repo/ui/shadcn/collapsible';
import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { cn } from '@repo/ui/utils';
import { apiCall, forgeAuthApi } from '@/api';
import { EmptyState } from '@/modules/core/components/EmptyState';
import { QueryError } from '@/modules/core/components/QueryError';
import { Payload } from '@/modules/monitoring/components/payload';
import { RowTrigger } from '@/modules/monitoring/components/row-trigger';
import { formatCost, formatTokens } from '@/modules/monitoring/monitoring.format';

const TRACE_LIMIT = 200;

const route = getRouteApi('/_authenticated/projects/$project_id/monitoring');

type SpanLlm = NonNullable<MonitoringTraceSpan['llm']>;

const formatDuration = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;

const scrollToRow = (row: HTMLTableRowElement | null) => row?.scrollIntoView({ block: 'center' });

const hasLlmCall = (trace: MonitoringTrace) => trace.spans.some((span) => span.llm !== null);

function spanBarColor(span: MonitoringTraceSpan) {
  if (span.failed) return 'bg-red-500';
  if (span.llm) return 'bg-chart-2';
  return 'bg-primary/70';
}

function llmSummary(trace: MonitoringTrace) {
  const calls = trace.spans.flatMap((span) => (span.llm ? [span.llm] : []));
  if (calls.length === 0) return '—';
  const cost = calls.reduce((total, call) => total + (call.cost ?? 0), 0);
  return `${calls.length} · ${formatCost(cost)}`;
}

interface TraceListProps {
  readonly project_id: string;
  readonly time_window: MetricsWindow;
}

export function TraceList({ project_id, time_window }: TraceListProps) {
  const { view, trace: focused_trace_id } = route.useSearch();
  const query = useQuery({
    queryKey: ['projects', project_id, 'monitoring', 'traces', time_window],
    queryFn: () =>
      apiCall<MonitoringTracesResponse>(() =>
        forgeAuthApi.projects[project_id]!.monitoring.traces.get({
          $query: { time_window, limit: TRACE_LIMIT },
        })
      ),
    retry: false,
  });

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
    return <Skeleton className="h-96 w-full rounded-[1.125rem]" />;
  }

  const llm_only = view === 'llm_traces';
  const traces = llm_only ? query.data.traces.filter(hasLlmCall) : query.data.traces;

  if (traces.length === 0) {
    return (
      <EmptyState test_id="traces-empty">
        {llm_only
          ? 'No traces with LLM calls in this window.'
          : 'No traces recorded in this window.'}
      </EmptyState>
    );
  }

  return (
    <div
      className="border-border/70 bg-card min-w-0 overflow-x-auto rounded-[1.125rem] border shadow-xs"
      data-testid="traces-table"
    >
      <table className="w-full border-collapse text-left font-mono text-xs">
        <thead className="text-muted-foreground border-border/50 border-b">
          <tr>
            <th className="w-44 px-4 py-2 font-normal">time</th>
            <th className="px-2 py-2 font-normal">trace</th>
            <th className="w-48 px-2 py-2 font-normal">agents</th>
            <th className="w-16 px-2 py-2 text-right font-normal">spans</th>
            <th className="w-28 px-2 py-2 text-right font-normal">llm</th>
            <th className="w-20 px-2 py-2 text-right font-normal">duration</th>
            <th className="w-9 px-2 py-2" />
          </tr>
        </thead>
        {traces.map((trace, index) => (
          <TraceRow
            key={trace.trace_id}
            trace={trace}
            index={index}
            focused={trace.trace_id === focused_trace_id}
          />
        ))}
      </table>
    </div>
  );
}

// The trace named in the URL opens on arrival and collapsing it drops it from the URL; every other
// row opens and closes on its own.
function TraceRow({
  trace,
  index,
  focused,
}: {
  readonly trace: MonitoringTrace;
  readonly index: number;
  readonly focused: boolean;
}) {
  const navigate = route.useNavigate();

  return (
    <Collapsible
      asChild
      defaultOpen={focused}
      onOpenChange={(open) => {
        if (open || !focused) return;
        void navigate({ search: (prev) => ({ ...prev, trace: undefined }), replace: true });
      }}
    >
      <tbody className="group/trace border-border/50 border-b last:border-b-0">
        <tr
          ref={focused ? scrollToRow : undefined}
          className="hover:bg-foreground/[0.03] has-[:focus-visible]:bg-foreground/[0.03] relative cursor-pointer"
        >
          <td className="text-muted-foreground px-4 py-2 align-top whitespace-nowrap">
            {trace.at}
          </td>
          <td
            className={`truncate px-2 py-2 align-top ${trace.failed ? 'text-red-500' : 'text-foreground'}`}
          >
            <RowTrigger data-testid={`trace-row-toggle-${index}`}>{trace.name}</RowTrigger>
          </td>
          <td className="text-muted-foreground truncate px-2 py-2 align-top">
            {trace.agents.length === 0 ? '—' : trace.agents.join(', ')}
          </td>
          <td className="text-muted-foreground px-2 py-2 text-right align-top whitespace-nowrap">
            {trace.span_count}
          </td>
          <td
            className="text-muted-foreground px-2 py-2 text-right align-top whitespace-nowrap"
            data-testid={`trace-row-llm-${index}`}
          >
            {llmSummary(trace)}
          </td>
          <td className="text-muted-foreground px-2 py-2 text-right align-top whitespace-nowrap">
            {formatDuration(trace.duration_ms)}
          </td>
          <td className="text-muted-foreground px-2 py-2 align-top">
            <ChevronDownIcon
              className="size-3.5 transition-transform group-data-[state=open]/trace:rotate-180"
              aria-hidden
            />
          </td>
        </tr>
        <CollapsibleContent asChild>
          <tr data-testid={`trace-spans-${index}`}>
            <td colSpan={7} className="bg-foreground/[0.02] px-4 py-3">
              <div className="text-muted-foreground mb-3">trace_id {trace.trace_id}</div>
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
        className={`w-1/3 truncate py-1 pr-3 ${span.failed ? 'text-red-500' : 'text-foreground'}`}
      >
        {children}
      </td>
      <td className="text-muted-foreground w-36 truncate py-1 pr-3">{span.agent ?? '—'}</td>
      <td className="py-1 pr-3">
        <div className="bg-foreground/[0.05] relative h-3 w-full rounded-sm">
          <div
            className={cn('absolute h-3 min-w-px rounded-sm', spanBarColor(span))}
            style={{ left: `${span.offset_ms * scale}%`, width: `${span.duration_ms * scale}%` }}
          />
        </div>
      </td>
      <td className="text-muted-foreground w-20 py-1 text-right whitespace-nowrap">
        {formatDuration(span.duration_ms)}
      </td>
    </>
  );
}
