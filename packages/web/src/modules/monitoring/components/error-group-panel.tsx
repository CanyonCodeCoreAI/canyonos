import type { MonitoringErrorGroup } from '@canyonos/api/monitoring';

import { EmptyState } from '@/modules/core/components/EmptyState';

interface ErrorGroupPanelProps {
  readonly title: string;
  readonly groups: readonly MonitoringErrorGroup[];
  readonly total: number;
  readonly test_id: string;
}

export function ErrorGroupPanel({ title, groups, total, test_id }: ErrorGroupPanelProps) {
  const largest = groups.reduce((max, group) => Math.max(max, group.count), 0);
  const listed = groups.reduce((sum, group) => sum + group.count, 0);

  return (
    <section
      className="border-border/70 bg-card flex min-w-0 flex-col rounded-[1.125rem] border p-5 shadow-xs"
      data-testid={test_id}
    >
      <header className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="text-foreground text-sm font-semibold">{title}</h2>
        <span className="text-muted-foreground text-xs tabular-nums">
          {total.toLocaleString()} total
        </span>
      </header>

      {groups.length === 0 ? (
        <EmptyState size="section" test_id={`${test_id}-empty`}>
          No errors in this window.
        </EmptyState>
      ) : (
        <>
          <dl className="flex flex-col gap-2.5">
            {groups.map((group) => (
              <div key={group.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3">
                <dt className="text-foreground truncate font-mono text-xs" title={group.key}>
                  {group.key}
                </dt>
                <dd className="text-foreground text-xs font-medium tabular-nums">
                  {group.count.toLocaleString()}
                </dd>
                <div className="bg-foreground/[0.06] col-span-2 mt-1 h-1.5 overflow-hidden rounded-full">
                  <div
                    className="bg-destructive h-full rounded-full"
                    style={{ width: `${largest === 0 ? 0 : (group.count / largest) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </dl>
          {listed < total ? (
            <p className="text-muted-foreground mt-3 text-xs">
              Showing the top {groups.length} of {total.toLocaleString()}.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
