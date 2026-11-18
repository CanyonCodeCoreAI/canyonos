// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowUpRightIcon } from 'lucide-react';

import type { MonitoringLlmCall } from '@canyonos/api/monitoring';

import { Card } from '@repo/ui/shadcn/card';
import { Collapsible, CollapsibleContent } from '@repo/ui/shadcn/collapsible';
import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { EmptyState } from '@/modules/core/components/EmptyState';
import { QueryError } from '@/modules/core/components/QueryError';
import { Payload } from '@/modules/monitoring/components/payload';
import { RowTrigger } from '@/modules/monitoring/components/row-trigger';
import { formatTokens } from '@/modules/monitoring/monitoring.format';
import { llmCallsQueryOptions } from '@/modules/monitoring/monitoring.queries';
import { formatMoneyValue } from '@/modules/projects/projects.format';
import type { RangeSelection } from '@/modules/core/time-range';

const CALL_LIMIT = 200;

const formatDuration = (ms: number | null) =>
  ms === null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;

const formatCost = (value: number | null) => (value === null ? '—' : formatMoneyValue(value));

interface LlmCallListProps {
  readonly project_id: string;
  readonly range: RangeSelection;
}

export function LlmCallList({ project_id, range }: LlmCallListProps) {
  const query = useQuery(llmCallsQueryOptions(project_id, { range, limit: CALL_LIMIT }));

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
    return <Skeleton className="h-96 w-full rounded-lg" />;
  }

  if (query.data.calls.length === 0) {
    return <EmptyState test_id="llm-empty">No LLM calls recorded in this window.</EmptyState>;
  }

  return (
    <Card className="min-w-0 overflow-x-auto" data-testid="llm-table">
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
          </tr>
        </thead>
        {query.data.calls.map((call, index) => (
          <LlmCallRow key={call.span_id} call={call} index={index} project_id={project_id} />
        ))}
      </table>
    </Card>
  );
}

function LlmCallRow({
  call,
  index,
  project_id,
}: {
  readonly call: MonitoringLlmCall;
  readonly index: number;
  readonly project_id: string;
}) {
  return (
    <Collapsible asChild>
      <tbody className="group/call border-border/50 border-b last:border-b-0">
        <tr className="hover:bg-foreground/[0.03] has-[:focus-visible]:bg-foreground/[0.03] relative cursor-pointer">
          <td className="text-muted-foreground px-4 py-2 align-top whitespace-nowrap">{call.at}</td>
          <td className="text-foreground truncate px-2 py-2 align-top">
            <RowTrigger data-testid={`llm-row-toggle-${index}`}>{call.model ?? '—'}</RowTrigger>
          </td>
          <td className="text-muted-foreground truncate px-2 py-2 align-top">
            {call.agent ?? '—'}
          </td>
          <td
            className={`truncate px-2 py-2 align-top break-words group-data-[state=open]/call:whitespace-pre-wrap ${call.failed ? 'text-red-500' : 'text-foreground'}`}
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
        </tr>
        <CollapsibleContent asChild>
          <tr>
            <td colSpan={8} className="bg-foreground/[0.02] px-4 py-3">
              <Link
                to="/projects/$project_id/monitoring"
                params={{ project_id }}
                search={(previous) => ({ ...previous, view: 'traces', trace: call.trace_id })}
                className="text-link mb-3 inline-flex items-center gap-1"
                data-testid={`llm-row-open-trace-${index}`}
              >
                Open trace
                <ArrowUpRightIcon className="size-3" aria-hidden />
              </Link>
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
        </CollapsibleContent>
      </tbody>
    </Collapsible>
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
