import { useQuery } from '@tanstack/react-query';
import { ChevronDownIcon } from 'lucide-react';
import { useState } from 'react';

import type { MetricsWindow } from '@canyonos/api/metrics';
import type { MonitoringLog, MonitoringLogsResponse } from '@canyonos/api/monitoring';

import { Card } from '@repo/ui/shadcn/card';
import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { apiCall, forgeAuthApi } from '@/api';
import { EmptyState } from '@/modules/core/components/EmptyState';
import { QueryError } from '@/modules/core/components/QueryError';

const LOG_LIMIT = 200;

const SEVERITY_CLASS: Record<string, string> = {
  ERROR: 'text-red-500',
  FATAL: 'text-red-500',
  WARN: 'text-amber-500',
  DEBUG: 'text-muted-foreground',
  TRACE: 'text-muted-foreground',
};

interface LogListProps {
  readonly project_id: string;
  readonly time_window: MetricsWindow;
  readonly errors_only?: boolean;
  readonly agent?: string;
  readonly replica?: string;
  readonly empty_message: string;
  readonly error_message: string;
  readonly test_id: string;
}

export function LogList({
  project_id,
  time_window,
  errors_only = false,
  agent,
  replica,
  empty_message,
  error_message,
  test_id,
}: LogListProps) {
  const query = useQuery({
    queryKey: [
      'projects',
      project_id,
      'monitoring',
      'logs',
      time_window,
      errors_only,
      agent ?? null,
      replica ?? null,
    ],
    queryFn: () =>
      apiCall<MonitoringLogsResponse>(() =>
        forgeAuthApi.projects[project_id]!.monitoring.logs.get({
          $query: {
            time_window,
            limit: LOG_LIMIT,
            errors_only,
            ...(agent === undefined ? {} : { agent }),
            ...(replica === undefined ? {} : { replica }),
          },
        })
      ),
    retry: false,
  });

  if (query.error) {
    return (
      <QueryError
        message={error_message}
        onRetry={() => void query.refetch()}
        test_id={`${test_id}-error`}
      />
    );
  }

  if (query.isPending) {
    return <Skeleton className="h-96 w-full rounded-lg" />;
  }

  if (query.data.logs.length === 0) {
    return <EmptyState test_id={`${test_id}-empty`}>{empty_message}</EmptyState>;
  }

  return (
    <Card className="min-w-0 overflow-x-auto" data-testid={`${test_id}-table`}>
      <table className="w-full border-collapse text-left font-mono text-xs">
        <tbody>
          {query.data.logs.map((log, index) => (
            <LogRow key={`${log.at}-${index}`} log={log} index={index} />
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function LogRow({ log, index }: { readonly log: MonitoringLog; readonly index: number }) {
  const [open, setOpen] = useState(false);
  const severity = log.severity ?? 'INFO';

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
        aria-label={open ? 'Collapse log record' : 'Expand log record'}
        data-testid={`log-row-toggle-${index}`}
        className="border-border/50 hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.03] cursor-pointer border-b last:border-b-0 focus-visible:outline-none"
      >
        <td className="text-muted-foreground w-44 px-4 py-2 align-top whitespace-nowrap">
          {log.at}
        </td>
        <td
          className={`w-20 px-2 py-2 align-top font-semibold whitespace-nowrap ${SEVERITY_CLASS[severity] ?? 'text-foreground'}`}
        >
          {severity}
        </td>
        <td className="text-muted-foreground w-40 truncate px-2 py-2 align-top">
          {log.agent ?? log.replica}
        </td>
        <td
          className={`text-foreground px-2 py-2 align-top break-words ${open ? 'whitespace-pre-wrap' : 'truncate'}`}
        >
          {log.body}
        </td>
        <td className="text-muted-foreground w-9 px-2 py-2 align-top">
          <ChevronDownIcon
            className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
            aria-hidden
          />
        </td>
      </tr>
      {open ? (
        <tr className="border-border/50 border-b last:border-b-0">
          <td colSpan={5} className="bg-foreground/[0.02] px-4 py-3">
            <pre className="text-foreground mb-3 break-words whitespace-pre-wrap">{log.body}</pre>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
              <LogField label="replica" value={log.replica} />
              <LogField label="trace_id" value={log.trace_id} />
              <LogField label="span_id" value={log.span_id} />
              <LogField label="severity_number" value={log.severity_number} />
              {Object.entries(log.attributes).map(([key, value]) => (
                <LogField key={key} label={key} value={value} />
              ))}
            </dl>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function LogField({ label, value }: { readonly label: string; readonly value: unknown }) {
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
