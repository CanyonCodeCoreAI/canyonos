// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import {
  ArrowRightIcon,
  BotIcon,
  GaugeIcon,
  InfoIcon,
  PlayIcon,
  PlusIcon,
  PowerIcon,
  RefreshCwIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { UseFormReturn } from 'react-hook-form';

import { AgentRulesSchema } from '@canyonos/api/governance';
import type {
  AgentRules,
  AgentStatus,
  CostAction,
  GovernanceAgent,
  GovernanceEdge,
  GovernanceResponse,
} from '@canyonos/api/governance';
import type { ScalingStatus } from '@canyonos/api/scaling';

import { FlowCanvas } from '@repo/ui/components/flow';
import { Button } from '@repo/ui/shadcn/button';
import { Input } from '@repo/ui/shadcn/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@repo/ui/shadcn/select';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@repo/ui/shadcn/sheet';
import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/shadcn/toggle-group';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@repo/ui/shadcn/tooltip';
import type {
  FlowEdgeSpec,
  FlowNodeFooterRow,
  FlowNodeSpec,
  FlowNodeTone,
} from '@repo/ui/components/flow';
import { EmptyState } from '@/modules/core/components/EmptyState';
import { QueryError } from '@/modules/core/components/QueryError';
import {
  governanceErrorMessage,
  governanceQueryOptions,
  useSaveAgentRules,
  useSetStopped,
} from '@/modules/governance/governance.queries';
import {
  policySummary,
  SCALING_SCOPE,
  ScalingPolicyCard,
} from '@/modules/scaling/scaling-policy-card';
import { scalingErrorMessage, scalingQueryOptions } from '@/modules/scaling/scaling.queries';

const route = getRouteApi('/_authenticated/projects/$project_id/governance');

const REM_PX = 16;
const COLUMN_STEP_PX = 18 * REM_PX;
const CARD_BODY_PX = 7 * REM_PX;
const FOOTER_EDGE_PX = 1 * REM_PX;
const FOOTER_ROW_PX = 1.75 * REM_PX;
const ROW_GAP_PX = 2 * REM_PX;
// A column stacks at most this many agents; past it the graph turns to rows, which wrap at it.
const MAX_AGENTS_IN_LINE = 6;
// A card's width (`nodeWidthToken`, 14rem) plus the gap between cards in a row.
const ROW_STEP_PX = 16 * REM_PX;
// Room between rows for the calls' elbows.
const LEVEL_GAP_PX = 4 * REM_PX;

// React Flow places top-left corners before it measures cards, so a column is stacked by an
// estimate that errs tall: a card grows with its footer rows, and a long model id wraps.
function cardHeightPx(footer: readonly FlowNodeFooterRow[]): number {
  if (footer.length === 0) return CARD_BODY_PX;
  return CARD_BODY_PX + FOOTER_EDGE_PX + footer.length * FOOTER_ROW_PX;
}

type ReadState = 'loading' | 'error' | 'ready';

// A retry after an error is a fresh load, not the old error; a failed poll keeps the last reading.
function readState(query: { isError: boolean; isFetching: boolean; data: unknown }): ReadState {
  if (query.data !== undefined) return 'ready';
  if (query.isError && !query.isFetching) return 'error';
  return 'loading';
}

interface NodeLook {
  readonly tag: string | null;
  readonly tone: FlowNodeTone | undefined;
}

const STATUS_LABEL: Record<AgentStatus, string> = {
  up: 'Up',
  down: 'Down',
  stopped: 'Stopped',
  unknown: 'No reading yet',
};

/** "Requires TestRunnerAgent +1": the first required agent not up and how many more. */
function requiresTag([first, ...rest]: readonly string[]): string {
  return rest.length === 0 ? `Requires ${first}` : `Requires ${first} +${rest.length}`;
}

function nodeLook(agent: GovernanceAgent): NodeLook {
  if (agent.status === 'down') return { tag: 'Down', tone: 'down' };
  if (agent.status === 'stopped') return { tag: 'Stopped', tone: 'warning' };
  if (agent.status === 'unknown') return { tag: 'No reading yet', tone: undefined };
  if (agent.unmet_requires.length > 0) {
    return { tag: requiresTag(agent.unmet_requires), tone: 'warning' };
  }
  if (agent.spend !== null && agent.spend.tripped_action !== null) {
    return { tag: 'Cap tripped', tone: 'warning' };
  }
  return { tag: null, tone: 'ok' };
}

const usd = (value: number) => `$${value.toFixed(2)}`;

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function spentPart(agent: GovernanceAgent): string[] {
  if (agent.spend === null) return [];
  return [`${usd(agent.spend.usd)} since ${day(agent.spend.since)}`];
}

function spendEffect(action: CostAction | null): string {
  if (action === null) return 'Within limits';
  switch (action.kind) {
    case 'switch_model':
      return `Switched to ${action.model}`;
    case 'deny':
      return 'Calls refused';
  }
}

function roleLine(agent: GovernanceAgent): string {
  return [
    `${agent.replicas_running}/${agent.replicas_expected} replicas`,
    ...spentPart(agent),
  ].join(' · ');
}

function actionTarget(action: CostAction): string {
  switch (action.kind) {
    case 'switch_model':
      return action.model;
    case 'deny':
      return 'deny';
  }
}

/** One row per required agent, then one per spend rule from the lowest threshold up. */
function footerRows(agent: GovernanceAgent): FlowNodeFooterRow[] {
  const requires = agent.rules.requires.map((name) => ({
    icon: 'requires' as const,
    label: `Requires ${name}`,
  }));
  const spend = [...(agent.rules.spend?.rules ?? [])]
    .sort((a, b) => a.above_usd - b.above_usd)
    .map((rule) => ({
      icon: 'spend' as const,
      label: `Above ${usd(rule.above_usd)} → ${actionTarget(rule.action)}`,
    }));
  return [...requires, ...spend];
}

const knownCalls = (agents: readonly GovernanceAgent[], edges: readonly GovernanceEdge[]) => {
  const names = new Set(agents.map((agent) => agent.name));
  return edges.filter(
    (edge) => edge.source !== edge.target && names.has(edge.source) && names.has(edge.target)
  );
};

type Orientation = 'columns' | 'rows';
type Point = FlowNodeSpec['position'];
type Level = readonly GovernanceAgent[];

const CALL_ANCHORS: Record<Orientation, Pick<FlowEdgeSpec, 'source_anchor' | 'target_anchor'>> = {
  columns: { source_anchor: 'right', target_anchor: 'left' },
  rows: { source_anchor: 'bottom', target_anchor: 'top' },
};

interface Layout {
  readonly positions: Map<string, Point>;
  /** How far below its card each caller's calls turn; a caller left out turns them halfway. */
  readonly bends: Map<string, number>;
}

/**
 * Agents grouped by the longest chain of callers above them, so a caller's level comes before what
 * it calls; each level keeps the order the API lists them. A cycle stops deepening at the agent
 * count.
 */
function callLevels(agents: readonly GovernanceAgent[], calls: readonly GovernanceEdge[]): Level[] {
  const deepest = Math.max(agents.length - 1, 0);
  const depth = new Map(agents.map((agent) => [agent.name, 0]));
  for (let pass = 0; pass < agents.length; pass += 1) {
    for (const { source, target } of calls) {
      const reached = Math.min((depth.get(source) ?? 0) + 1, deepest);
      depth.set(target, Math.max(depth.get(target) ?? 0, reached));
    }
  }
  const levels = Array.from({ length: deepest + 1 }, (): GovernanceAgent[] => []);
  for (const agent of agents) levels[depth.get(agent.name) ?? 0]?.push(agent);
  return levels.filter((level) => level.length > 0);
}

const levelHeightPx = (level: Level) =>
  Math.max(...level.map((agent) => cardHeightPx(footerRows(agent))));

function columnLayout(levels: readonly Level[]): Layout {
  const positions = new Map<string, Point>();
  levels.forEach((level, column) => {
    let y = 0;
    for (const agent of level) {
      positions.set(agent.name, { x: column * COLUMN_STEP_PX, y });
      y += cardHeightPx(footerRows(agent)) + ROW_GAP_PX;
    }
  });
  return { positions, bends: new Map() };
}

const wrapped = (level: Level): Level[] =>
  Array.from({ length: Math.ceil(level.length / MAX_AGENTS_IN_LINE) }, (_, row) =>
    level.slice(row * MAX_AGENTS_IN_LINE, (row + 1) * MAX_AGENTS_IN_LINE)
  );

/**
 * Each level a row, centred on the widest one. A level wraps every MAX_AGENTS_IN_LINE agents, each
 * second row shifted half a card so its cards sit under the gaps the calls into it pass through.
 * Calls turn below the caller's whole level, so one from a first-row card drops through those gaps
 * instead of turning behind the row under it.
 */
function rowLayout(levels: readonly Level[]): Layout {
  const widest = Math.max(...levels.map((level) => Math.min(level.length, MAX_AGENTS_IN_LINE)));
  const positions = new Map<string, Point>();
  const bends = new Map<string, number>();
  let y = 0;
  for (const level of levels) {
    const rows = wrapped(level);
    const indent = ((widest - (rows[0]?.length ?? 0)) * ROW_STEP_PX) / 2;
    rows.forEach((row, index) => {
      const shift = index % 2 === 1 ? ROW_STEP_PX / 2 : 0;
      row.forEach((agent, column) => {
        positions.set(agent.name, { x: indent + shift + column * ROW_STEP_PX, y });
      });
      y += levelHeightPx(row) + LEVEL_GAP_PX;
    });
    const levelBottom = y - LEVEL_GAP_PX;
    for (const agent of level) {
      const cardBottom = (positions.get(agent.name)?.y ?? 0) + cardHeightPx(footerRows(agent));
      bends.set(agent.name, levelBottom - cardBottom + LEVEL_GAP_PX / 2);
    }
  }
  return { positions, bends };
}

const LAYOUT: Record<Orientation, (levels: readonly Level[]) => Layout> = {
  columns: columnLayout,
  rows: rowLayout,
};

function agentNode(agent: GovernanceAgent, position: Point): FlowNodeSpec {
  const { tag, tone } = nodeLook(agent);
  return {
    id: agent.name,
    position,
    data: {
      kind: 'agent',
      file: agent.name,
      role: roleLine(agent),
      tag,
      tone,
      chips: [],
      footer: footerRows(agent),
    },
  };
}

/**
 * Levels of callers as columns, left to right, until one level holds more than MAX_AGENTS_IN_LINE;
 * then as rows, top to bottom, so a wide fan-out spreads across the canvas instead of down it.
 */
function governanceFlow(
  agents: readonly GovernanceAgent[],
  edges: readonly GovernanceEdge[]
): { nodes: FlowNodeSpec[]; edges: FlowEdgeSpec[] } {
  const calls = knownCalls(agents, edges);
  const levels = callLevels(agents, calls);
  const orientation: Orientation = levels.some((level) => level.length > MAX_AGENTS_IN_LINE)
    ? 'rows'
    : 'columns';
  const { positions, bends } = LAYOUT[orientation](levels);
  return {
    nodes: agents.map((agent) => agentNode(agent, positions.get(agent.name) ?? { x: 0, y: 0 })),
    edges: calls.map(({ source, target }) => ({
      id: `${source}->${target}`,
      source,
      target,
      ...CALL_ANCHORS[orientation],
      data: { edge_type: 'call', label: null, bend_from_source: bends.get(source) },
    })),
  };
}

const governanceNodeTestId = (id: string) => `governance-node-${id}`;

const TOOLBAR_PANEL =
  'bg-card/80 rounded-[calc(var(--radius-sm)+0.1875rem)] p-[0.1875rem] shadow-[0_0_0_1px_var(--flow-node-edge),var(--shadow-sm)] backdrop-blur-md backdrop-saturate-150';
const TOOLBAR_BUTTON =
  'text-muted-foreground hover:text-foreground h-7 gap-1.5 px-2.5 text-xs active:scale-[0.96] focus-visible:ring-ring focus-visible:ring-2';

// Both sheets slide over the canvas on the same drawer curve, quicker out than in. They take half
// the canvas so a rule reads on one line; a narrow canvas gives them 28rem, or all of it.
const SHEET_OVERLAY = 'bg-black/10 dark:bg-black/45';
const SHEET_PANEL =
  'w-[max(50%,min(28rem,100%))] max-w-none gap-0 overflow-y-auto shadow-[var(--shadow-lg)] ease-[cubic-bezier(0.32,0.72,0,1)] data-[state=closed]:duration-200 data-[state=open]:duration-300 motion-reduce:animate-none sm:max-w-none';
const SHEET_HEADER = 'border-border/60 flex-row items-start gap-3 border-b px-6 py-5';
const SHEET_ICON =
  'bg-muted ring-border/70 grid size-9 shrink-0 place-items-center rounded-lg ring-1 [&_svg]:size-4';
// The status colour marks the dot and tints the pill; text stays foreground, which the status
// colours are too light to carry at this size.
const STATUS_COLOR =
  'data-[status=up]:[--status:var(--flow-workflow)] data-[status=down]:[--status:var(--destructive)] data-[status=stopped]:[--status:var(--chart-3)] data-[status=unknown]:[--status:var(--muted-foreground)]';

type Panel = 'policy';

export function GovernanceScreen({
  project_id,
  agent,
  panel,
}: {
  readonly project_id: string;
  readonly agent: string | undefined;
  readonly panel: Panel | undefined;
}) {
  const query = useQuery(governanceQueryOptions(project_id));

  return (
    <main
      className="flex min-h-0 flex-1 flex-col gap-5 p-7"
      data-testid="governance-screen"
      data-state={readState(query)}
      data-project-id={project_id}
    >
      <header className="flex flex-col gap-1.5">
        <h1 className="text-foreground text-[1.5rem] leading-none font-bold tracking-tight text-balance">
          Governance
        </h1>
        <p className="text-muted-foreground max-w-prose text-sm text-pretty">
          Each agent with what it calls. Open one to set the agents it needs up, cap what it spends,
          or stop it; the scaling policy sets how every agent grows and shrinks.
        </p>
      </header>
      <GovernanceBody project_id={project_id} query={query} agent={agent} panel={panel} />
    </main>
  );
}

function GovernanceBody({
  project_id,
  query,
  agent,
  panel,
}: {
  readonly project_id: string;
  readonly query: UseQueryResult<GovernanceResponse, Error>;
  readonly agent: string | undefined;
  readonly panel: Panel | undefined;
}) {
  const navigate = route.useNavigate();
  // Holds the canvas box element for the drawer's portal: Radix reads its container at render.
  const [canvasBox, setCanvasBox] = useState<HTMLDivElement | null>(null);

  if (query.data === undefined && query.isError && !query.isFetching) {
    return (
      <QueryError
        className="max-w-3xl"
        message={governanceErrorMessage(query.error, 'Could not load the agents.')}
        onRetry={() => void query.refetch()}
        test_id="governance-error"
        retry_test_id="governance-retry"
      />
    );
  }
  if (query.data === undefined) {
    return (
      <Skeleton
        className="min-h-[28rem] w-full flex-1 rounded-lg"
        aria-busy="true"
        data-testid="governance-loading"
      />
    );
  }
  if (query.data.agents.length === 0) {
    return (
      <EmptyState size="section" test_id="governance-empty">
        The controller has not published any agents yet.
      </EmptyState>
    );
  }
  const { agents, edges } = query.data;
  const flow = governanceFlow(agents, edges);
  return (
    <>
      <RefreshError query={query} />
      <div
        ref={setCanvasBox}
        className="border-border/60 relative isolate min-h-[28rem] flex-1 overflow-hidden rounded-lg border"
      >
        {/* The canvas keeps its edges from mount, so a new call between agents remounts it. */}
        <FlowCanvas
          key={flow.edges.map((call) => call.id).join('\n')}
          nodes={flow.nodes}
          edges={flow.edges}
          nodeTestId={governanceNodeTestId}
          onNodeClick={(id) => void navigate({ search: { agent: id } })}
          showControls
          data-testid="governance-canvas"
        />
        <div
          className={`absolute top-3 right-3 z-10 flex items-center gap-0.5 ${TOOLBAR_PANEL}`}
          role="toolbar"
          aria-label="Canvas"
        >
          <PolicyLine project_id={project_id} />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className={TOOLBAR_BUTTON}
            aria-haspopup="dialog"
            aria-expanded={panel === 'policy'}
            onClick={() => void navigate({ search: { panel: 'policy' } })}
            data-testid="governance-policy"
          >
            <GaugeIcon aria-hidden />
            Scaling policy
          </Button>
          <span className="bg-border mx-0.5 h-4 w-px" aria-hidden />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className={TOOLBAR_BUTTON}
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
            data-testid="governance-sync"
          >
            <RefreshCwIcon
              aria-hidden
              className={query.isFetching ? 'animate-spin motion-reduce:animate-none' : undefined}
            />
            Sync
          </Button>
        </div>
        <AgentDrawer
          project_id={project_id}
          agents={agents}
          agent={
            panel === undefined ? agents.find((candidate) => candidate.name === agent) : undefined
          }
          container={canvasBox}
          onClose={() => void navigate({ search: { agent: undefined } })}
        />
        <PolicySheet
          project_id={project_id}
          open={panel === 'policy'}
          container={canvasBox}
          onClose={() => void navigate({ search: { panel: undefined } })}
        />
      </div>
    </>
  );
}

/** A failed poll over a reading already shown: the canvas and an open drawer stay as they were. */
function RefreshError({ query }: { readonly query: UseQueryResult<GovernanceResponse, Error> }) {
  if (!query.isError || query.isFetching) return null;
  return (
    <QueryError
      message={`${governanceErrorMessage(query.error, 'Could not refresh the agents.')} Showing the last reading.`}
      onRetry={() => void query.refetch()}
      test_id="governance-refresh-error"
      retry_test_id="governance-refresh-retry"
    />
  );
}

type ScalingRead = UseQueryResult<ScalingStatus, Error>;

function policyLine(query: ScalingRead): string {
  if (query.data !== undefined) return policySummary(query.data);
  if (query.isError && !query.isFetching) return 'Policy unavailable';
  return 'Reading policy…';
}

/** The stored policy in one muted line beside its button, so it reads without opening. */
function PolicyLine({ project_id }: { readonly project_id: string }) {
  const query = useQuery(scalingQueryOptions(project_id));
  return (
    <span
      className="text-muted-foreground px-2 text-xs whitespace-nowrap tabular-nums"
      data-testid="governance-policy-line"
      data-policy={query.data?.status ?? readState(query)}
    >
      {policyLine(query)}
    </span>
  );
}

/** The project's one scaling policy, edited in the same sheet the agents open in. */
function PolicySheet({
  project_id,
  open,
  container,
  onClose,
}: {
  readonly project_id: string;
  readonly open: boolean;
  readonly container: HTMLElement | null;
  readonly onClose: () => void;
}) {
  if (!open || container === null) return null;
  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        container={container}
        overlayClassName={SHEET_OVERLAY}
        className={SHEET_PANEL}
        showCloseButton={false}
        data-testid="governance-policy-sheet"
      >
        <SheetHeader className={SHEET_HEADER}>
          <span className={`${SHEET_ICON} text-muted-foreground`} aria-hidden>
            <GaugeIcon />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <SheetTitle className="text-base font-semibold tracking-tight">
              Scaling policy
            </SheetTitle>
            <SheetDescription className="max-w-prose text-xs text-pretty">
              {SCALING_SCOPE}
            </SheetDescription>
          </div>
          <CloseButton />
        </SheetHeader>
        <div className="px-6 py-5">
          <PolicyBody project_id={project_id} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function PolicyBody({ project_id }: { readonly project_id: string }) {
  const query = useQuery(scalingQueryOptions(project_id));
  if (query.data === undefined && query.isError && !query.isFetching) {
    return (
      <QueryError
        message={scalingErrorMessage(query.error, 'Could not load the policy.')}
        onRetry={() => void query.refetch()}
        test_id="governance-policy-error"
        retry_test_id="governance-policy-retry"
      />
    );
  }
  if (query.data === undefined) {
    return <Skeleton className="h-44 w-full rounded-lg" aria-busy="true" />;
  }
  return (
    <TooltipProvider delayDuration={300}>
      {/* Keyed on the stored policy: a save or delete re-reads it and remounts the card closed. */}
      <ScalingPolicyCard
        key={JSON.stringify(query.data)}
        project_id={project_id}
        policy={query.data}
      />
    </TooltipProvider>
  );
}

function CloseButton() {
  return (
    <SheetClose asChild>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="text-muted-foreground -mt-1 -mr-2 size-8 shrink-0"
      >
        <XIcon aria-hidden />
        <span className="sr-only">Close</span>
      </Button>
    </SheetClose>
  );
}

function AgentDrawer({
  project_id,
  agents,
  agent,
  container,
  onClose,
}: {
  readonly project_id: string;
  readonly agents: readonly GovernanceAgent[];
  readonly agent: GovernanceAgent | undefined;
  readonly container: HTMLElement | null;
  readonly onClose: () => void;
}) {
  if (agent === undefined || container === null) return null;
  return (
    <Sheet
      key={agent.name}
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        container={container}
        overlayClassName={SHEET_OVERLAY}
        className={SHEET_PANEL}
        showCloseButton={false}
        data-testid="governance-drawer"
      >
        <TooltipProvider delayDuration={200}>
          <AgentHeader project_id={project_id} agent={agent} />
          <div className="flex flex-1 flex-col px-6 pt-5">
            <RulesForm project_id={project_id} agents={agents} agent={agent} />
          </div>
        </TooltipProvider>
      </SheetContent>
    </Sheet>
  );
}

function StatusPill({ status }: { readonly status: AgentStatus }) {
  return (
    <span
      className={`text-foreground inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[color-mix(in_srgb,var(--status)_14%,transparent)] px-2 py-0.5 text-[0.6875rem] leading-4 font-medium ${STATUS_COLOR}`}
      data-status={status}
      data-testid="governance-drawer-status"
    >
      <span className="size-1.5 rounded-full bg-(--status)" aria-hidden />
      {STATUS_LABEL[status]}
    </span>
  );
}

/** The agent at a glance, with the one action that changes its replicas: stop or start it. */
function AgentHeader({
  project_id,
  agent,
}: {
  readonly project_id: string;
  readonly agent: GovernanceAgent;
}) {
  const set = useSetStopped(project_id, agent.name);
  const stopped = agent.status === 'stopped';
  const warn = agent.scaling_policy_present && !stopped;
  const error = set.error
    ? governanceErrorMessage(set.error, `Could not ${stopped ? 'start' : 'stop'} the agent.`)
    : null;

  return (
    <>
      <SheetHeader className={SHEET_HEADER}>
        <span className={`${SHEET_ICON} text-flow-agent`} aria-hidden>
          <BotIcon />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <SheetTitle className="truncate text-base font-semibold tracking-tight">
              {agent.name}
            </SheetTitle>
            <StatusPill status={agent.status} />
          </div>
          <SheetDescription className="text-xs tabular-nums">{roleLine(agent)}</SheetDescription>
        </div>
        <Button
          type="button"
          size="sm"
          variant={stopped ? 'default' : 'outline'}
          className="active:scale-[0.96]"
          disabled={set.isPending}
          aria-describedby={warn ? 'governance-stop-note' : undefined}
          onClick={() => set.mutate(!stopped)}
        >
          {stopped ? <PlayIcon aria-hidden /> : <PowerIcon aria-hidden />}
          {stopped ? 'Start agent' : 'Stop agent'}
        </Button>
        <CloseButton />
      </SheetHeader>
      <HeaderNotes warn={warn} error={error} />
    </>
  );
}

function HeaderNotes({ warn, error }: { readonly warn: boolean; readonly error: string | null }) {
  if (!warn && error === null) return null;
  return (
    <div className="border-border/60 bg-muted/40 flex flex-col gap-1 border-b px-6 py-2.5">
      <ScalingNote warn={warn} />
      <FormError error={error} test_id="governance-stop-error" />
    </div>
  );
}

function ScalingNote({ warn }: { readonly warn: boolean }) {
  if (!warn) return null;
  return (
    <p
      id="governance-stop-note"
      className="text-muted-foreground text-xs text-pretty"
      data-testid="governance-stop-note"
    >
      A scaling policy is set, so the controller starts it again at its minimum replicas.
    </p>
  );
}

function FormError({
  error,
  test_id,
}: {
  readonly error: string | null;
  readonly test_id: string;
}) {
  if (error === null) return null;
  return (
    <p className="text-destructive text-xs" role="alert" data-testid={test_id}>
      {error}
    </p>
  );
}

const NEW_RULE = { above_usd: 1, action: { kind: 'deny' } } as const;

/** `datetime-local` speaks local wall time without a zone; the rules store an ISO instant. */
function toLocalInput(iso: string | undefined): string {
  if (iso === undefined) return '';
  const at = new Date(iso);
  return new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function RulesForm({
  project_id,
  agents,
  agent,
}: {
  readonly project_id: string;
  readonly agents: readonly GovernanceAgent[];
  readonly agent: GovernanceAgent;
}) {
  const save = useSaveAgentRules(project_id, agent.name);
  // `since` is always a key: its date field registers it, and a key the stored rules lack would
  // read as an edit before any.
  const stored: AgentRules = {
    requires: agent.rules.requires,
    spend: { since: undefined, ...(agent.rules.spend ?? { rules: [] }) },
  };
  const form = useForm<AgentRules>({
    resolver: zodResolver(AgentRulesSchema),
    values: stored,
    resetOptions: { keepDirtyValues: true },
  });
  const rules = useFieldArray({ control: form.control, name: 'spend.rules' });
  const others = agents.filter((other) => other.name !== agent.name);
  // Reset to what was saved, so a saved form is clean and follows the polled rules again.
  const submit = form.handleSubmit((values) =>
    save.mutate(
      {
        requires: values.requires,
        spend: values.spend === null || values.spend.rules.length === 0 ? null : values.spend,
      },
      { onSuccess: () => form.reset(values) }
    )
  );

  return (
    <form
      className="flex flex-1 flex-col gap-4"
      aria-label={`Rules of ${agent.name}`}
      data-state={save.isPending ? 'saving' : 'editing'}
      onSubmit={submit}
    >
      <Section
        title="Requires"
        info={`Calls to ${agent.name} are refused with DependencyDown while any agent picked here has no healthy replica.`}
      >
        <Controller
          control={form.control}
          name="requires"
          render={({ field }) => (
            <RequiresToggle others={others} value={field.value} onChange={field.onChange} />
          )}
        />
        <UnmetRequires unmet={agent.unmet_requires} />
      </Section>

      <Section
        title="Spend rules"
        info="Past a threshold, the agent's LLM calls switch to another model, or its calls are refused with SpendLimit. When several thresholds are passed, the highest one decides."
      >
        <SpendSummary agent={agent} />
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1.5 text-xs">
            <span className="text-muted-foreground flex items-center gap-1.5 font-medium">
              Count spend from
              <InfoTip label="About the spend start">
                Spend counts from this date. Left empty, the stored start is kept; a new rule counts
                from the moment it is saved.
              </InfoTip>
            </span>
            <Controller
              control={form.control}
              name="spend.since"
              render={({ field }) => (
                <Input
                  type="datetime-local"
                  className="w-auto tabular-nums"
                  value={toLocalInput(field.value)}
                  onChange={(event) =>
                    field.onChange(
                      event.target.value === ''
                        ? undefined
                        : new Date(event.target.value).toISOString()
                    )
                  }
                />
              )}
            />
          </label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="active:scale-[0.96]"
            onClick={() =>
              form.setValue('spend.since', new Date().toISOString(), { shouldDirty: true })
            }
          >
            From now
          </Button>
        </div>
        <RuleList empty={rules.fields.length === 0}>
          {rules.fields.map((field, index) => (
            <SpendRuleRow
              key={field.id}
              form={form}
              index={index}
              models={agent.models}
              onRemove={() => rules.remove(index)}
            />
          ))}
        </RuleList>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="border-border text-muted-foreground hover:text-foreground hover:border-foreground/25 w-full border border-dashed active:scale-[0.99]"
          onClick={() => rules.append(NEW_RULE)}
        >
          <PlusIcon aria-hidden />
          Add rule
        </Button>
      </Section>

      <FormError
        error={save.error ? governanceErrorMessage(save.error, 'Could not save the rules.') : null}
        test_id="governance-form-error"
      />
      <div className="border-border/60 bg-background/85 sticky bottom-0 -mx-6 mt-auto flex items-center justify-between gap-3 border-t px-6 py-3.5 backdrop-blur-md">
        <SaveState dirty={form.formState.isDirty} />
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!form.formState.isDirty || save.isPending}
            onClick={() => {
              form.reset(stored, { keepDirtyValues: false });
              save.reset();
            }}
          >
            Discard
          </Button>
          <Button type="submit" size="sm" className="active:scale-[0.96]" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save rules'}
          </Button>
        </div>
      </div>
    </form>
  );
}

function SaveState({ dirty }: { readonly dirty: boolean }) {
  if (!dirty) {
    return (
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
        Rules apply on the controller&apos;s next poll.
        <InfoTip label="About the poll">
          Each replica&apos;s controller rereads its rules every poll interval, the{' '}
          <code className="font-mono">poll_interval</code> in{' '}
          <code className="font-mono">global_controller.yaml</code> (5 seconds by default), so a
          save takes effect within seconds, without a redeploy.
        </InfoTip>
      </p>
    );
  }
  return (
    <p className="text-foreground flex items-center gap-2 text-xs font-medium" role="status">
      <span className="bg-chart-3 size-1.5 rounded-full" aria-hidden />
      Unsaved changes
    </p>
  );
}

function Section({
  title,
  info,
  children,
}: {
  readonly title: string;
  readonly info: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="bg-card ring-border/70 flex flex-col gap-3 rounded-xl p-4 ring-1">
      <h3 className="text-foreground flex items-center gap-1.5 text-[0.8125rem] font-semibold">
        {title}
        <InfoTip label={`About ${title.toLowerCase()}`}>{info}</InfoTip>
      </h3>
      {children}
    </section>
  );
}

/** A help icon whose tooltip explains the term beside it, on hover and on keyboard focus. */
function InfoTip({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring relative inline-grid size-4 shrink-0 place-items-center rounded-full transition-colors after:absolute after:-inset-3 focus-visible:ring-2 focus-visible:outline-none"
        >
          <InfoIcon className="size-3.5" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent sideOffset={6} className="max-w-72 leading-relaxed font-normal text-pretty">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}

function RequiresToggle({
  others,
  value,
  onChange,
}: {
  readonly others: readonly GovernanceAgent[];
  readonly value: string[];
  readonly onChange: (value: string[]) => void;
}) {
  if (others.length === 0) {
    return <p className="text-muted-foreground text-xs">There is no other agent to require.</p>;
  }
  return (
    <ToggleGroup
      type="multiple"
      size="sm"
      variant="outline"
      className="flex-wrap justify-start gap-1.5 bg-transparent p-0"
      aria-label="Requires"
      value={value}
      onValueChange={onChange}
    >
      {others.map((other) => (
        <ToggleGroupItem
          key={other.name}
          value={other.name}
          className="data-[state=on]:border-flow-agent/45 data-[state=on]:bg-flow-agent/10 h-8 gap-2 rounded-md px-2.5 text-xs font-medium shadow-none data-[state=on]:shadow-none"
        >
          <span
            className={`size-1.5 shrink-0 rounded-full bg-(--status) ${STATUS_COLOR}`}
            data-status={other.status}
            aria-hidden
          />
          {other.name}
          <ChipStatus status={other.status} />
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/** An agent that is not up says so in text too, not by its dot's colour alone. */
function ChipStatus({ status }: { readonly status: AgentStatus }) {
  if (status === 'up') return null;
  return <span className="text-muted-foreground font-normal"> {STATUS_LABEL[status]}</span>;
}

function UnmetRequires({ unmet }: { readonly unmet: readonly string[] }) {
  if (unmet.length === 0) return null;
  return (
    <p
      className="bg-destructive/8 text-destructive flex items-start gap-2 rounded-lg px-3 py-2 text-xs text-pretty"
      data-testid="governance-unmet"
    >
      <TriangleAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden />
      Not up right now: {unmet.join(', ')}. Calls to this agent are refused.
    </p>
  );
}

/** What the agent has spent since its rules started counting, and what that does to it now. */
function SpendSummary({ agent }: { readonly agent: GovernanceAgent }) {
  if (agent.spend === null) return null;
  return (
    <dl
      className="bg-border/60 ring-border/60 flex flex-wrap gap-px overflow-hidden rounded-lg ring-1"
      data-testid="governance-spend"
    >
      <SpendStat
        label="Spent"
        value={usd(agent.spend.usd)}
        info="Model spend from the agent's telemetry since the start date. The dashboard refreshes it about once a minute."
      />
      <SpendStat label="Counting since" value={day(agent.spend.since)} />
      <SpendStat label="Now" value={spendEffect(agent.spend.tripped_action)} wide />
    </dl>
  );
}

function SpendStat({
  label,
  value,
  info,
  wide = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly info?: string;
  readonly wide?: boolean;
}) {
  return (
    <div
      className="bg-card flex min-w-0 flex-1 basis-32 flex-col gap-1 px-3 py-2.5 data-[wide=true]:grow-[2] data-[wide=true]:basis-48"
      data-wide={wide}
    >
      <dt className="text-muted-foreground flex items-center gap-1.5 text-[0.6875rem] font-medium tracking-wide uppercase">
        {label}
        <StatInfo label={label} info={info} />
      </dt>
      <dd className="text-foreground text-sm font-semibold break-words tabular-nums">{value}</dd>
    </div>
  );
}

function StatInfo({ label, info }: { readonly label: string; readonly info: string | undefined }) {
  if (info === undefined) return null;
  return <InfoTip label={`About ${label.toLowerCase()}`}>{info}</InfoTip>;
}

function RuleList({ empty, children }: { readonly empty: boolean; readonly children: ReactNode }) {
  if (empty) {
    return (
      <p className="text-muted-foreground ring-border/60 rounded-lg px-3 py-3 text-xs ring-1">
        No spend rules: calls run at any spend.
      </p>
    );
  }
  return (
    <div className="divide-border/60 ring-border/60 divide-y overflow-hidden rounded-lg ring-1">
      {children}
    </div>
  );
}

const ACTION_LABEL: Record<CostAction['kind'], string> = {
  switch_model: 'Switch model',
  deny: 'Refuse calls',
};

function SpendRuleRow({
  form,
  index,
  models,
  onRemove,
}: {
  readonly form: UseFormReturn<AgentRules>;
  readonly index: number;
  readonly models: readonly string[] | null;
  readonly onRemove: () => void;
}) {
  const threshold = `spend.rules.${index}.above_usd` as const;
  const threshold_invalid = form.getFieldState(threshold, form.formState).invalid;
  return (
    <div
      className="flex flex-wrap items-center gap-2 px-3 py-2.5"
      data-testid="governance-spend-rule"
    >
      <label className="text-muted-foreground flex items-center gap-2 text-xs font-medium">
        Above
        <span className="relative">
          <span
            className="pointer-events-none absolute inset-y-0 left-2.5 grid place-items-center"
            aria-hidden
          >
            $
          </span>
          <Input
            type="number"
            step="0.01"
            min="0"
            className="text-foreground w-24 pl-5.5 tabular-nums"
            aria-label="Above USD"
            aria-invalid={threshold_invalid}
            {...form.register(threshold, { valueAsNumber: true })}
          />
        </span>
      </label>
      <ArrowRightIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
      <Controller
        control={form.control}
        name={`spend.rules.${index}.action`}
        render={({ field, fieldState }) => (
          <ActionFields
            action={field.value}
            models={models}
            invalid={fieldState.invalid}
            onChange={field.onChange}
          />
        )}
      />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="text-muted-foreground hover:text-destructive ml-auto size-8"
        aria-label="Remove rule"
        onClick={onRemove}
      >
        <Trash2Icon aria-hidden />
      </Button>
      <RuleError message={threshold_invalid ? 'Enter an amount above $0.' : null} />
    </div>
  );
}

function RuleError({ message }: { readonly message: string | null }) {
  if (message === null) return null;
  return (
    <p className="text-destructive w-full text-xs" role="alert">
      {message}
    </p>
  );
}

function ActionFields({
  action,
  models,
  invalid,
  onChange,
}: {
  readonly action: CostAction;
  readonly models: readonly string[] | null;
  readonly invalid: boolean;
  readonly onChange: (action: CostAction) => void;
}) {
  return (
    <>
      <Select
        value={action.kind}
        onValueChange={(kind) =>
          onChange(kind === 'deny' ? { kind } : { kind: 'switch_model', model: models?.[0] ?? '' })
        }
      >
        <SelectTrigger aria-label="Action" className="w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="switch_model" disabled={models?.length === 0}>
            {ACTION_LABEL.switch_model}
          </SelectItem>
          <SelectItem value="deny">{ACTION_LABEL.deny}</SelectItem>
        </SelectContent>
      </Select>
      <ModelField action={action} models={models} invalid={invalid} onChange={onChange} />
    </>
  );
}

/** A pick from the models llms.yaml allows, or any model id when the project has no llms.yaml. */
function ModelField({
  action,
  models,
  invalid,
  onChange,
}: {
  readonly action: CostAction;
  readonly models: readonly string[] | null;
  readonly invalid: boolean;
  readonly onChange: (action: CostAction) => void;
}) {
  if (action.kind !== 'switch_model') return null;
  if (models === null) {
    return (
      <Input
        aria-label="Model"
        aria-invalid={invalid}
        className="min-w-40 flex-1 font-mono text-xs"
        placeholder="Model id"
        value={action.model}
        onChange={(event) => onChange({ ...action, model: event.target.value })}
      />
    );
  }
  const options = models.includes(action.model) ? models : [action.model, ...models];
  return (
    <Select value={action.model} onValueChange={(model) => onChange({ ...action, model })}>
      <SelectTrigger
        aria-label="Model"
        aria-invalid={invalid}
        className="min-w-40 flex-1 font-mono text-xs"
      >
        <SelectValue placeholder="Pick a model" />
      </SelectTrigger>
      <SelectContent>
        {options.filter(Boolean).map((model) => (
          <SelectItem key={model} value={model} className="font-mono text-xs">
            {model}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
