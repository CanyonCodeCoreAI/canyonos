import { useQuery } from '@tanstack/react-query';
import { ChevronDownIcon } from 'lucide-react';
import { useState } from 'react';

import type { MetricsWindow } from '@canyonos/api/metrics';
import type {
  MonitoringTrace,
  MonitoringTraceSpan,
  MonitoringTracesResponse,
} from '@canyonos/api/monitoring';

import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { apiCall, forgeAuthApi } from '@/api';
import { EmptyState } from '@/modules/core/components/EmptyState';
import { QueryError } from '@/modules/core/components/QueryError';

const TRACE_LIMIT = 200;

const formatDuration = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;

interface TraceListProps {
  readonly project_id: string;
  readonly time_window: MetricsWindow;
}

export function TraceList({ project_id, time_window }: TraceListProps) {
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

  if (query.data.traces.length === 0) {
    return <EmptyState test_id="traces-empty">No traces recorded in this window.</EmptyState>;
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
            <th className="w-20 px-2 py-2 text-right font-normal">duration</th>
            <th className="w-9 px-2 py-2" />
          </tr>
        </thead>
        <tbody>
          {query.data.traces.map((trace, index) => (
            <TraceRow key={trace.trace_id} trace={trace} index={index} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TraceRow({ trace, index }: { readonly trace: MonitoringTrace; readonly index: number }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <tr
        onClick={() => setOpen((was) => !was)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          setOpen((was) => !was);
        }}
        tabIndex={0}
        role="button"
        aria-expanded={open}
        aria-label={open ? 'Collapse trace' : 'Expand trace'}
        data-testid={`trace-row-toggle-${index}`}
        className="border-border/50 hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.03] cursor-pointer border-b last:border-b-0 focus-visible:outline-none"
      >
        <td className="text-muted-foreground px-4 py-2 align-top whitespace-nowrap">{trace.at}</td>
        <td
          className={`truncate px-2 py-2 align-top ${trace.failed ? 'text-red-500' : 'text-foreground'}`}
        >
          {trace.name}
        </td>
        <td className="text-muted-foreground truncate px-2 py-2 align-top">
          {trace.agents.length === 0 ? '—' : trace.agents.join(', ')}
        </td>
        <td className="text-muted-foreground px-2 py-2 text-right align-top whitespace-nowrap">
          {trace.span_count}
        </td>
        <td className="text-muted-foreground px-2 py-2 text-right align-top whitespace-nowrap">
          {formatDuration(trace.duration_ms)}
        </td>
        <td className="text-muted-foreground px-2 py-2 align-top">
          <ChevronDownIcon
            className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
            aria-hidden
          />
        </td>
      </tr>
      {open ? (
        <tr className="border-border/50 border-b last:border-b-0">
          <td colSpan={6} className="bg-foreground/[0.02] px-4 py-3">
            <div className="text-muted-foreground mb-3">trace_id {trace.trace_id}</div>
            <table className="w-full border-collapse">
              <tbody>
                {trace.spans.map((span) => (
                  <SpanRow key={span.span_id} span={span} total_ms={trace.duration_ms} />
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function SpanRow({
  span,
  total_ms,
}: {
  readonly span: MonitoringTraceSpan;
  readonly total_ms: number;
}) {
  const scale = total_ms > 0 ? 100 / total_ms : 0;

  return (
    <tr className="align-top">
      <td
        className={`w-1/3 truncate py-1 pr-3 ${span.failed ? 'text-red-500' : 'text-foreground'}`}
      >
        {span.name}
        {span.status_message === null ? null : (
          <span className="text-muted-foreground"> — {span.status_message}</span>
        )}
      </td>
      <td className="text-muted-foreground w-36 truncate py-1 pr-3">{span.agent ?? '—'}</td>
      <td className="py-1 pr-3">
        <div className="bg-foreground/[0.05] relative h-3 w-full rounded-sm">
          <div
            className={`absolute h-3 min-w-px rounded-sm ${span.failed ? 'bg-red-500' : 'bg-primary/70'}`}
            style={{ left: `${span.offset_ms * scale}%`, width: `${span.duration_ms * scale}%` }}
          />
        </div>
      </td>
      <td className="text-muted-foreground w-20 py-1 text-right whitespace-nowrap">
        {formatDuration(span.duration_ms)}
      </td>
    </tr>
  );
}
