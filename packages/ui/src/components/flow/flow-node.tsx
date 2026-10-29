// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Handle, Position } from '@xyflow/react';
import { BotIcon, CoinsIcon, LinkIcon, WorkflowIcon, WrenchIcon } from 'lucide-react';
import { use } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '../../lib/utils';
import { Card } from '../../shadcn/card';
import { FlowChromeContext } from './flow-chrome';
import { chipColorToken, nodeColorToken, nodeWidthToken } from './flow-tokens';
import type { FlowNode } from './flow-hoc';
import type {
  FlowAnchor,
  FlowNodeChip,
  FlowNodeFooterRow,
  FlowNodeKind,
  FlowNodeTone,
} from './types';

const KIND_LABEL: Readonly<Record<FlowNodeKind, string>> = {
  workflow: 'Workflow',
  agent: 'Agent',
  tool: 'Tool',
};

const KIND_ICON: Readonly<Record<FlowNodeKind, LucideIcon>> = {
  workflow: WorkflowIcon,
  agent: BotIcon,
  tool: WrenchIcon,
};

const FOOTER_ICON: Readonly<Record<FlowNodeFooterRow['icon'], LucideIcon>> = {
  requires: LinkIcon,
  spend: CoinsIcon,
};

const STATUS_DOT: Readonly<Record<FlowNodeTone | 'none', string>> = {
  ok: 'var(--flow-workflow)',
  warning: 'var(--chart-3)',
  down: 'var(--destructive)',
  none: 'var(--muted-foreground)',
};

const ANCHORS: readonly { anchor: FlowAnchor; position: Position }[] = [
  { anchor: 'top', position: Position.Top },
  { anchor: 'bottom', position: Position.Bottom },
  { anchor: 'left', position: Position.Left },
  { anchor: 'right', position: Position.Right },
];

// The tint is layered over the card surface rather than replacing it, so the canvas grid never
// shows through a card that carries a tone. The edge colour rides on `--flow-node-edge`, which
// the card's hairline shadow reads.
const toneClass = [
  'data-[tone=warning]:[--flow-node-edge:color-mix(in_srgb,var(--chart-3)_45%,transparent)]',
  'data-[tone=warning]:bg-[linear-gradient(color-mix(in_srgb,var(--chart-3)_5%,transparent),color-mix(in_srgb,var(--chart-3)_5%,transparent))]',
  'data-[tone=down]:[--flow-node-edge:color-mix(in_srgb,var(--destructive)_45%,transparent)]',
  'data-[tone=down]:bg-[linear-gradient(color-mix(in_srgb,var(--destructive)_4%,transparent),color-mix(in_srgb,var(--destructive)_4%,transparent))]',
].join(' ');

const hiddenHandle =
  'size-[0.0625rem]! min-w-0! min-h-0! border-0! bg-transparent! opacity-0 pointer-events-none';

function tint(token: string, percent: number): string {
  return `color-mix(in srgb, ${token} ${percent}%, transparent)`;
}

// The directory reads as context and the basename as the card's identity.
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
  const KindIcon = KIND_ICON[data.kind];

  return (
    <div className="relative" data-testid={nodeTestId(id)}>
      <AnchorHandles />
      <Card
        data-kind={data.kind}
        data-tone={data.tone}
        data-selected={selected}
        className={cn(
          'flow-node-card gap-0 overflow-hidden border-0',
          'ease-snappy transition-[box-shadow,background-color] duration-150',
          toneClass
        )}
        style={{ width: nodeWidthToken }}
      >
        <div className="flex flex-col gap-1.5 px-3.5 py-3">
          <span className="flex items-start gap-2">
            <KindIcon
              className="mt-0.5 size-4 shrink-0"
              style={{ color }}
              role="img"
              aria-label={KIND_LABEL[data.kind]}
            />
            <NodeName file={data.file} />
          </span>
          <NodeRole role={data.role} />
          <NodeStatus tone={data.tone} tag={data.tag} />
          <NodeChips chips={data.chips} />
        </div>
        <NodeFooter rows={data.footer} />
      </Card>
    </div>
  );
}

// A card is identified by its file, so the name wraps instead of eliding. `break-all` is what
// actually wraps snake_case names, which carry no spaces or hyphens for a normal break to land on.
function NodeName({ file }: { readonly file: string }) {
  const { dir, base } = splitPath(file);
  return (
    <span className="text-foreground min-w-0 text-[0.9375rem] leading-tight font-semibold break-all">
      <span className="text-muted-foreground font-normal">{dir}</span>
      {base}
    </span>
  );
}

function NodeRole({ role }: { readonly role: string }) {
  if (role === '') return null;
  return <span className="text-muted-foreground text-xs leading-snug tabular-nums">{role}</span>;
}

function NodeStatus({
  tone,
  tag,
}: {
  readonly tone: FlowNodeTone | undefined;
  readonly tag: string | null;
}) {
  const dot = STATUS_DOT[tone ?? 'none'];
  return (
    <span className="text-foreground/85 mt-1 flex items-center gap-2 text-xs font-medium">
      <span
        className="size-[0.4375rem] shrink-0 rounded-full"
        style={{
          backgroundColor: dot,
          boxShadow: `0 0 0 0.1875rem ${tint(dot, 18)}`,
        }}
        aria-hidden
      />
      {tag ?? 'Online'}
    </span>
  );
}

function NodeChips({ chips }: { readonly chips: readonly FlowNodeChip[] }) {
  if (chips.length === 0) return null;
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => {
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
            <span className="font-mono text-[0.6875rem] font-semibold" style={{ color: chipColor }}>
              {chip.label}
            </span>
          </span>
        );
      })}
    </div>
  );
}

function NodeFooter({ rows }: { readonly rows: readonly FlowNodeFooterRow[] }) {
  if (rows.length === 0) return null;
  return (
    <ul className="border-border/60 bg-muted/60 flex flex-col gap-1 border-t px-3.5 py-2 dark:bg-white/[0.025]">
      {rows.map((row) => {
        const RowIcon = FOOTER_ICON[row.icon];
        return (
          <li
            key={`${row.icon}-${row.label}`}
            className="text-muted-foreground flex items-start gap-2 text-xs leading-snug tabular-nums"
          >
            <RowIcon className="mt-[0.1875rem] size-3 shrink-0 opacity-80" aria-hidden />
            <span className="min-w-0 break-words">{row.label}</span>
          </li>
        );
      })}
    </ul>
  );
}
