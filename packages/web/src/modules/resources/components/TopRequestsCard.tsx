import { ActivityIcon, CheckIcon, CircleXIcon, FolderIcon, LoaderCircleIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { RequestStatus } from '@cc-forge/api/resources';

import { CardHeading } from '@repo/ui/components/card-heading';
import { Card } from '@repo/ui/shadcn/card';
import { cn } from '@repo/ui/utils';
import type { TopRequestRow } from '@/modules/resources/resources.selectors';

const STATUS_META: Record<RequestStatus, { icon: LucideIcon; className: string; label: string }> = {
  ok: { icon: CheckIcon, className: 'text-primary', label: 'Completed' },
  running: { icon: LoaderCircleIcon, className: 'text-chart-3', label: 'Running' },
  error: { icon: CircleXIcon, className: 'text-destructive', label: 'Failed' },
};

const COLUMNS = 'grid grid-cols-[1.4fr_1fr_0.8fr_0.8fr_0.8fr_0.9fr] items-center gap-3';

interface TopRequestsCardProps {
  title: string;
  usageHeader: string;
  rows: readonly TopRequestRow[];
}

export function TopRequestsCard({ title, usageHeader, rows }: TopRequestsCardProps) {
  return (
    <Card className="gap-0 overflow-hidden rounded-2xl py-5" data-testid="top-requests-card">
      <div className="flex items-center justify-between gap-2 px-5 pb-3.5">
        <CardHeading icon={ActivityIcon}>{title}</CardHeading>
      </div>

      <div
        className={cn(
          COLUMNS,
          'border-border/60 text-muted-foreground border-y px-5 py-2 text-[0.625rem] font-semibold tracking-wide uppercase'
        )}
      >
        <span>Request</span>
        <span>Workflow</span>
        <span className="text-right">{usageHeader}</span>
        <span className="text-right">Run time</span>
        <span className="text-right">Latency</span>
        <span className="text-right">When</span>
      </div>

      <ul>
        {rows.map((row) => {
          const status = STATUS_META[row.status];
          const StatusIcon = status.icon;
          return (
            <li
              key={row.id}
              className={cn(
                COLUMNS,
                'border-border/40 hover:bg-muted border-b px-5 py-3 last:border-b-0'
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                <StatusIcon
                  className={cn('size-3.5 shrink-0', status.className)}
                  aria-label={status.label}
                />
                <span className="text-foreground min-w-0 truncate font-mono text-xs font-semibold">
                  {row.id}
                </span>
              </span>
              <span className="flex min-w-0 items-center gap-1.5">
                <FolderIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
                <span className="text-secondary-foreground min-w-0 truncate text-xs">
                  {row.projectName}
                </span>
              </span>
              <span className="text-foreground text-right font-mono text-xs font-semibold tabular-nums">
                {row.usageLabel}
              </span>
              <span className="text-secondary-foreground text-right font-mono text-xs tabular-nums">
                {row.runTimeLabel}
              </span>
              <span className="text-secondary-foreground text-right font-mono text-xs tabular-nums">
                {row.latencyLabel}
              </span>
              <span className="text-muted-foreground text-right text-xs">{row.timeLabel}</span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
