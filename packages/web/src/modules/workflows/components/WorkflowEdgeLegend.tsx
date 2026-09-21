import type { WorkflowEdgeLegendItem } from '@/modules/workflows/workflows.selectors';

interface WorkflowEdgeLegendProps {
  items: readonly WorkflowEdgeLegendItem[];
}

export function WorkflowEdgeLegend({ items }: WorkflowEdgeLegendProps) {
  return (
    <div className="flex flex-wrap items-center gap-5" data-testid="workflow-edge-legend">
      {items.map((item) => (
        <span
          key={item.id}
          className="text-muted-foreground inline-flex items-center gap-2 text-xs font-semibold"
        >
          <svg width="24" height="8" className="overflow-visible" aria-hidden>
            <line
              x1="1"
              y1="4"
              x2="23"
              y2="4"
              stroke={item.color}
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={item.dashed ? '5 3' : undefined}
            />
          </svg>
          {item.label}
        </span>
      ))}
    </div>
  );
}
