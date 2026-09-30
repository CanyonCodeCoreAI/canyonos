import { useQuery } from '@tanstack/react-query';
import { ChevronDownIcon } from 'lucide-react';
import { useState } from 'react';

import type { MetricsWindow } from '@canyonos/api/metrics';
import type { MonitoringLlmCall, MonitoringLlmCallsResponse } from '@canyonos/api/monitoring';

import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { apiCall, forgeAuthApi } from '@/api';
import { EmptyState } from '@/modules/core/components/EmptyState';
import { QueryError } from '@/modules/core/components/QueryError';

const CALL_LIMIT = 200;

const formatDuration = (ms: number | null) =>
  ms === null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;

const formatTokens = (value: number | null) => (value === null ? '—' : value.toLocaleString());

const formatCost = (value: number | null) => (value === null ? '—' : `$${value.toFixed(4)}`);

interface LlmCallListProps {
  readonly project_id: string;
  readonly time_window: MetricsWindow;
}

export function LlmCallList({ project_id, time_window }: LlmCallListProps) {
  const query = useQuery({
    queryKey: ['projects', project_id, 'monitoring', 'llm', time_window],
    queryFn: () =>
      apiCall<MonitoringLlmCallsResponse>(() =>
        forgeAuthApi.projects[project_id]!.monitoring.llm.get({
          $query: { time_window, limit: CALL_LIMIT },
        })
      ),
    retry: false,
  });

  if (query.error) {
    return (
      <QueryError
        message="Could not load LLM calls."
        onRetry={() => void query.refetch()}
        test_id="llm-error"
      />
    );
  }

  if (query.isPending) {
    return <Skeleton className="h-96 w-full rounded-[1.125rem]" />;
  }

  if (query.data.calls.length === 0) {
    return <EmptyState test_id="llm-empty">No LLM calls recorded in this window.</EmptyState>;
  }

  return (
    <div
      className="border-border/70 bg-card min-w-0 overflow-x-auto rounded-[1.125rem] border shadow-xs"
      data-testid="llm-table"
    >
      <table className="w-full border-collapse text-left font-mono text-xs">
        <thead className="text-muted-foreground border-border/50 border-b">
          <tr>
            <th className="w-44 px-4 py-2 font-normal">time</th>
            <th className="w-48 px-2 py-2 font-normal">model</th>
            <th className="w-36 px-2 py-2 font-normal">agent</th>
            <th className="px-2 py-2 font-normal">span</th>
            <th className="w-20 px-2 py-2 text-right font-normal">tokens in</th>
            <th className="w-20 px-2 py-2 text-right font-normal">out</th>
            <th className="w-20 px-2 py-2 text-right font-normal">latency</th>
            <th className="w-20 px-2 py-2 text-right font-normal">cost</th>
            <th className="w-9 px-2 py-2" />
          </tr>
        </thead>
        <tbody>
          {query.data.calls.map((call, index) => (
            <LlmCallRow key={call.span_id} call={call} index={index} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LlmCallRow({ call, index }: { readonly call: MonitoringLlmCall; readonly index: number }) {
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
        aria-label={open ? 'Collapse LLM call' : 'Expand LLM call'}
        data-testid={`llm-row-toggle-${index}`}
        className="border-border/50 hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.03] cursor-pointer border-b last:border-b-0 focus-visible:outline-none"
      >
        <td className="text-muted-foreground px-4 py-2 align-top whitespace-nowrap">{call.at}</td>
        <td className="text-foreground truncate px-2 py-2 align-top">{call.model ?? '—'}</td>
        <td className="text-muted-foreground truncate px-2 py-2 align-top">{call.agent ?? '—'}</td>
        <td
          className={`px-2 py-2 align-top break-words ${call.failed ? 'text-red-500' : 'text-foreground'} ${open ? 'whitespace-pre-wrap' : 'truncate'}`}
        >
          {call.name}
        </td>
        <td className="text-muted-foreground px-2 py-2 text-right align-top whitespace-nowrap">
          {formatTokens(call.input_tokens)}
        </td>
        <td className="text-muted-foreground px-2 py-2 text-right align-top whitespace-nowrap">
          {formatTokens(call.output_tokens)}
        </td>
        <td className="text-muted-foreground px-2 py-2 text-right align-top whitespace-nowrap">
          {formatDuration(call.duration_ms)}
        </td>
        <td className="text-muted-foreground px-2 py-2 text-right align-top whitespace-nowrap">
          {formatCost(call.cost)}
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
          <td colSpan={9} className="bg-foreground/[0.02] px-4 py-3">
            {call.input === null ? null : <Payload label="input" value={call.input} />}
            {call.output === null ? null : <Payload label="output" value={call.output} />}
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
              <CallField label="trace_id" value={call.trace_id} />
              <CallField label="span_id" value={call.span_id} />
              <CallField label="status_message" value={call.status_message} />
              <CallField
                label="cache_hit_ratio"
                value={
                  call.cache_hit_ratio === null
                    ? null
                    : `${Math.round(call.cache_hit_ratio * 100)}%`
                }
              />
              {Object.entries(call.attributes).map(([key, value]) => (
                <CallField key={key} label={key} value={value} />
              ))}
            </dl>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function Payload({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="mb-3">
      <div className="text-muted-foreground mb-1">{label}</div>
      <pre className="text-foreground break-words whitespace-pre-wrap">{value}</pre>
    </div>
  );
}

function CallField({ label, value }: { readonly label: string; readonly value: unknown }) {
  if (value === null || value === undefined) return null;
  return (
    <>
      <dt className="text-muted-foreground whitespace-nowrap">{label}</dt>
      <dd className="text-foreground break-words">
        {typeof value === 'string' ? value : JSON.stringify(value)}
      </dd>
    </>
  );
}
