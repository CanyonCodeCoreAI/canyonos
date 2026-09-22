import { Handle, Position } from '@xyflow/react';
import { use } from 'react';
import type { NodeProps } from '@xyflow/react';

import { cn } from '../../lib/utils';
import { FlowChromeContext } from './flow-chrome';
import { chipColorToken, nodeColorToken, nodeWidthToken } from './flow-tokens';
import type { FlowNode } from './flow-hoc';
import type { FlowAnchor, FlowNodeKind } from './types';

const KIND_LABEL: Readonly<Record<FlowNodeKind, string>> = {
  workflow: 'Workflow',
  agent: 'Agent',
  tool: 'Tool',
};

const ANCHORS: readonly { anchor: FlowAnchor; position: Position }[] = [
  { anchor: 'top', position: Position.Top },
  { anchor: 'bottom', position: Position.Bottom },
  { anchor: 'left', position: Position.Left },
  { anchor: 'right', position: Position.Right },
];

const hiddenHandle =
  'size-[0.0625rem]! min-w-0! min-h-0! border-0! bg-transparent! opacity-0 pointer-events-none';

function tint(token: string, percent: number): string {
  return `color-mix(in srgb, ${token} ${percent}%, transparent)`;
}

// Split a path so the directory reads as context and the basename as the card's identity: the two
// carry different weight and colour, and both wrap rather than elide.
function splitPath(path: string): { dir: string; base: string } {
  const slash = path.lastIndexOf('/');
  return slash === -1
    ? { dir: '', base: path }
    : { dir: path.slice(0, slash + 1), base: path.slice(slash + 1) };
}

function AnchorHandles() {
  return (
    <>
      {ANCHORS.map(({ anchor, position }) => (
        <span key={anchor}>
          <Handle
            type="source"
            id={anchor}
            position={position}
            isConnectable={false}
            className={hiddenHandle}
          />
          <Handle
            type="target"
            id={anchor}
            position={position}
            isConnectable={false}
            className={hiddenHandle}
          />
        </span>
      ))}
    </>
  );
}

export function FlowNodeCard({ id, data, selected }: NodeProps<FlowNode>) {
  const { nodeTestId } = use(FlowChromeContext);
  const color = nodeColorToken[data.kind];
  const { dir, base } = splitPath(data.file);

  return (
    <div className="relative" data-testid={nodeTestId(id)}>
      <AnchorHandles />
      <div
        className={cn(
          'bg-card flex flex-col gap-1.5 rounded-xl border px-3.5 py-3 shadow-xs transition-shadow duration-150',
          selected ? 'border-transparent' : 'border-border/60 hover:border-border hover:shadow-sm'
        )}
        style={{
          width: nodeWidthToken,
          borderColor: selected ? color : undefined,
          boxShadow: selected
            ? `0 0 0 3px color-mix(in srgb, ${color} 18%, transparent), var(--shadow-sm)`
            : undefined,
        }}
      >
        <span className="flex w-full items-center justify-between gap-2">
          <span
            className="inline-flex items-center gap-1.5 rounded-md border py-0.5 pr-2 pl-1.5"
            style={{ backgroundColor: tint(color, 10), borderColor: tint(color, 30) }}
          >
            <span
              className="size-1.5 shrink-0 rounded-sm"
              style={{ backgroundColor: color }}
              aria-hidden
            />
            <span
              className="font-mono text-[0.6875rem] font-semibold tracking-wider uppercase"
              style={{ color }}
            >
              {KIND_LABEL[data.kind]}
            </span>
          </span>
          {data.tag ? (
            <span
              className="rounded-md px-1.5 py-0.5 text-[0.625rem] font-bold tracking-wider uppercase"
              style={{
                color: nodeColorToken.workflow,
                backgroundColor: tint(nodeColorToken.workflow, 12),
              }}
            >
              {data.tag}
            </span>
          ) : null}
        </span>

        {/* The path wraps instead of truncating: a card is identified by its file, and two elided
          halves ("age… sandbox_agent.…") identify nothing. `break-all` is what actually wraps these
          — snake_case names carry no spaces or hyphens for a normal break to land on. */}
        <span className="w-full font-mono text-[0.8125rem] font-semibold break-all">
          {dir ? <span className="text-muted-foreground font-normal">{dir}</span> : null}
          <span className="text-foreground">{base}</span>
        </span>

        {data.role ? (
          <span className="text-muted-foreground text-xs leading-snug">{data.role}</span>
        ) : null}

        {data.chips.length > 0 ? (
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            {data.chips.map((chip) => {
              const chipColor = chipColorToken[chip.kind];
              return (
                <span
                  key={`${chip.kind}-${chip.label}`}
                  className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5"
                  style={{ backgroundColor: tint(chipColor, 12) }}
                >
                  <span
                    className="size-1.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: chipColor }}
                    aria-hidden
                  />
                  <span
                    className="font-mono text-[0.6875rem] font-semibold"
                    style={{ color: chipColor }}
                  >
                    {chip.label}
                  </span>
                </span>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
