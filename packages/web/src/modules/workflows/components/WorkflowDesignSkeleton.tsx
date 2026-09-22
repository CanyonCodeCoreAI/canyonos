import { Loader2Icon } from 'lucide-react';

import { Legend } from '@repo/ui/components/legend';
import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { buildComponentLegend } from '@/modules/workflows/workflows.selectors';

// A short vertical chain of faux nodes reads as a flow taking shape — the skeleton hints at the
// structure that's coming rather than showing a neutral block. Accent dots reuse the real node
// palette so the placeholder and the finished graph share a visual language.
const SKELETON_NODES: readonly {
  id: string;
  accent: string;
  width: string;
  hasRole: boolean;
}[] = [
  { id: 'workflow', accent: 'var(--flow-workflow)', width: '13rem', hasRole: true },
  { id: 'agent', accent: 'var(--flow-agent)', width: '12rem', hasRole: true },
  { id: 'tool', accent: 'var(--flow-tool)', width: '10.5rem', hasRole: false },
];

function SkeletonNode({
  accent,
  width,
  hasRole,
}: {
  accent: string;
  width: string;
  hasRole: boolean;
}) {
  return (
    <div
      className="bg-card border-border/60 flex flex-col gap-2 rounded-xl border px-3.5 py-3 shadow-xs"
      style={{ width }}
    >
      <span className="flex items-center gap-1.5">
        <span
          className="size-1.5 shrink-0 rounded-sm"
          style={{ backgroundColor: accent }}
          aria-hidden
        />
        <Skeleton className="h-2.5 w-14 rounded" />
      </span>
      <Skeleton className="h-3.5 w-28 rounded" />
      {hasRole ? <Skeleton className="h-2.5 w-20 rounded" /> : null}
    </div>
  );
}

/**
 * Left-column placeholder for the graph. With `generating` it stays on screen while the design is
 * produced (a spinning label communicates ongoing work); otherwise it is a brief load shimmer. The
 * chrome matches the real graph panel so the canvas materialises in place.
 */
export function GraphSkeletonPanel({ generating = false }: { generating?: boolean }) {
  return (
    <div
      className="border-border bg-muted flex min-h-[28rem] min-w-0 flex-col overflow-hidden rounded-2xl border shadow-sm lg:h-full lg:min-h-0"
      data-testid={generating ? 'workflow-design-generating' : 'workflow-graph-loading'}
      aria-busy="true"
    >
      <div className="border-border/60 bg-card/70 flex min-h-[2.75rem] flex-wrap items-center justify-between gap-3 border-b px-4 py-2.5 backdrop-blur-sm">
        <span className="flex items-center gap-2">
          <span className="text-foreground text-sm font-semibold tracking-tight">Flow graph</span>
          {generating ? (
            <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs font-medium">
              <Loader2Icon
                className="size-3.5 motion-safe:animate-spin"
                strokeWidth={2.2}
                aria-hidden
              />
              Generating design…
            </span>
          ) : null}
        </span>
        <Legend items={buildComponentLegend()} />
      </div>
      <div className="bg-muted flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden py-8">
        {SKELETON_NODES.map((node, index) => (
          <span key={node.id} className="flex flex-col items-center">
            {index > 0 ? <span className="bg-border/70 h-7 w-px" aria-hidden /> : null}
            <SkeletonNode accent={node.accent} width={node.width} hasRole={node.hasRole} />
          </span>
        ))}
      </div>
    </div>
  );
}
