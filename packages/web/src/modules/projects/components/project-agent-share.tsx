import type { MetricsBlock } from '@canyonos/api/metrics';

import { DonutChart } from '@repo/ui/components/charts/donut-chart';
import { cn } from '@repo/ui/utils';
import type { ChartConfig } from '@repo/ui/shadcn/chart';
import { AnalyzeButton } from '@/modules/projects/components/project-analyze-button';
import {
  formatCount,
  formatMoneyValue,
  formatShare,
  parseMoney,
} from '@/modules/projects/projects.format';
import { AGENT_SHARE_HUES, AGENT_SHARE_OTHER_COLOR } from '@/modules/projects/projects.metrics';
import type { SelectedBlock } from '@/modules/projects/components/project-block-drawer';

const OTHER_KEY = 'other';

interface Slice {
  readonly key: string;
  readonly value: number;
  readonly label: string;
  readonly color: string;
  /** The one agent the slice stands for, or null for the folded tail. */
  readonly block: MetricsBlock | null;
}

interface ProjectAgentShareProps {
  /** Dearest first, the order the list reads in. */
  readonly rows: readonly MetricsBlock[];
  readonly total: number;
  readonly onSelectBlock: (block: SelectedBlock) => void;
  /** The `agent_id`s offered an analysis. Read by the owner so both views mark the same agents. */
  readonly analyzable: ReadonlySet<string>;
  /** The owner's preview note, which every Analyze pill points at. */
  readonly preview_id: string;
}

/**
 * Per-agent spend as a part-to-whole read.
 *
 * Fed the rows the list shows rather than fetching its own, so the two views cannot disagree. Only
 * the dearest few get a hue: past that the slices are thinner than the gap between them, and the
 * list is the view that answers questions about the tail. Selecting a named slice opens the drawer
 * its row would open.
 */
export function ProjectAgentShare({
  rows,
  total,
  onSelectBlock,
  analyzable,
  preview_id,
}: ProjectAgentShareProps) {
  const slices = buildSlices(rows);
  const config: ChartConfig = Object.fromEntries(
    slices.map((slice) => [slice.key, { label: slice.label, color: slice.color }])
  );

  const open = (slice: Slice | undefined) => {
    if (slice?.block) {
      onSelectBlock({ agent_id: slice.block.agent_id, label: slice.block.label });
    }
  };

  return (
    <div
      className="flex min-w-0 flex-col items-center gap-6 py-2 lg:flex-row lg:gap-8 lg:px-4"
      data-testid="project-agent-share"
    >
      <DonutChart
        className="w-[11.5rem] shrink-0"
        data={slices.map(({ key, value }) => ({ key, value }))}
        config={config}
        centerValue={formatMoneyValue(total)}
        centerLabel="Total"
        tooltipValueFormatter={(datum) =>
          `${formatMoneyValue(datum.value)} · ${formatShare(datum.value, total)}`
        }
        onSegmentSelect={(key) => open(slices.find((slice) => slice.key === key))}
      />

      {/* The legend is also the direct label: two of the palette's tokens sit under 3:1 against the
          card, so each share has to be readable as text and not only as an arc. */}
      <ul className="flex min-w-0 flex-1 flex-col gap-0.5 self-stretch lg:justify-center">
        {slices.map((slice) => {
          return (
            // The row is the grid and the click target is an overlay inside it, so the Analyze
            // pill can sit between the name and the figures without nesting one button in another.
            // The overlay stays transparent: it is above the cells, so a background on it would
            // paint over them. Hover and focus are drawn on the row instead.
            <li
              key={slice.key}
              className={cn(
                'relative grid grid-cols-[0.5rem_minmax(0,1fr)_5rem_3.5rem] items-center gap-3 rounded-lg px-3 py-2 transition-colors',
                'has-[button:enabled]:hover:bg-muted/60',
                'has-[button:focus-visible]:ring-ring has-[button:focus-visible]:ring-2 has-[button:focus-visible]:ring-inset'
              )}
            >
              <button
                type="button"
                // The folded tail stands for many agents, so it has no single drawer to open.
                disabled={slice.block === null}
                onClick={() => open(slice)}
                // The overlay carries no text, so the name it opens has to be said here.
                aria-label={`Open metrics for ${slice.label}`}
                // Addressed by agent, not by rank, so the drawer can hand focus back to the entry it
                // was opened from whichever view is showing.
                data-testid={`project-agent-share-row-${slice.block?.agent_id ?? slice.key}`}
                className="absolute inset-0 z-[1] rounded-lg outline-none disabled:cursor-default"
              />
              <span
                className="size-2 shrink-0 rounded-sm"
                style={{ backgroundColor: slice.color }}
                aria-hidden
              />
              <span className="flex min-w-0 items-center gap-2">
                <span className="text-foreground min-w-0 truncate font-mono text-[0.8125rem]">
                  {slice.label}
                </span>
                {slice.block !== null && analyzable.has(slice.block.agent_id) ? (
                  <AnalyzeButton
                    subject={slice.label}
                    describedBy={preview_id}
                    test_id={`project-agent-share-analyze-${slice.block.agent_id}`}
                  />
                ) : null}
              </span>
              <span className="text-foreground text-right font-mono text-[0.8125rem] tabular-nums">
                {formatMoneyValue(slice.value)}
              </span>
              <span className="text-muted-foreground text-right font-mono text-xs tabular-nums">
                {formatShare(slice.value, total)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The dearest agents by name, with whatever is left over as one neutral slice. */
function buildSlices(rows: readonly MetricsBlock[]): readonly Slice[] {
  const head = rows.slice(0, AGENT_SHARE_HUES.length);
  const tail = rows.slice(AGENT_SHARE_HUES.length);

  const slices: Slice[] = head.map((block, index) => ({
    // Keyed by rank rather than by label: a label can be any string, and this key reaches a CSS
    // custom property name via the chart config.
    key: `agent-${index}`,
    value: parseMoney(block.cost),
    label: block.label,
    color: AGENT_SHARE_HUES[index]!,
    block,
  }));

  if (tail.length > 0) {
    slices.push({
      key: OTHER_KEY,
      value: tail.reduce((sum, block) => sum + parseMoney(block.cost), 0),
      label: `${formatCount(tail.length)} more ${tail.length === 1 ? 'agent' : 'agents'}`,
      color: AGENT_SHARE_OTHER_COLOR,
      block: null,
    });
  }

  return slices;
}
