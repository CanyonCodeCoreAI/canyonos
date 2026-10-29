// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { GaugeIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
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
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@repo/ui/shadcn/sheet';
import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/shadcn/toggle-group';
import { TooltipProvider } from '@repo/ui/shadcn/tooltip';
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
  if (agent.spend !== null && agent.spend.tripped_rule_index !== null) {
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

/** "$7.00 since Oct 20, 2026 · cap $5.00": the spend and the lowest threshold it is held to. */
function spendParts(agent: GovernanceAgent): string[] {
  if (agent.spend === null) return [];
  const thresholds = (agent.rules.spend?.rules ?? []).map((rule) => rule.above_usd);
  const cap = thresholds.length === 0 ? [] : [`cap ${usd(Math.min(...thresholds))}`];
  return [...spentPart(agent), ...cap];
}

function trippedPart(agent: GovernanceAgent): string[] {
  const index = agent.spend?.tripped_rule_index ?? null;
  const rule = index === null ? undefined : agent.rules.spend?.rules[index];
  if (rule === undefined) return [];
  switch (rule.action.kind) {
    case 'switch_model':
      return [`switched to ${rule.action.model}`];
    case 'deny':
      return ['calls refused'];
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

/**
 * Agents in columns by the longest chain of callers above them, so a caller sits left of what it
 * calls; agents in one column stack in the order the API lists them. A cycle stops deepening at
 * the agent count.
 */
export function layoutNodes(
  agents: readonly GovernanceAgent[],
  edges: readonly GovernanceEdge[]
): FlowNodeSpec[] {
  const calls = knownCalls(agents, edges);
  const deepest = Math.max(agents.length - 1, 0);
  const depth = new Map(agents.map((agent) => [agent.name, 0]));
  for (let pass = 0; pass < agents.length; pass += 1) {
    for (const { source, target } of calls) {
      const reached = Math.min((depth.get(source) ?? 0) + 1, deepest);
      depth.set(target, Math.max(depth.get(target) ?? 0, reached));
    }
  }
  const columnBottom = new Map<number, number>();
  return agents.map((agent) => {
    const column = depth.get(agent.name) ?? 0;
    const y = columnBottom.get(column) ?? 0;
    const footer = footerRows(agent);
    columnBottom.set(column, y + cardHeightPx(footer) + ROW_GAP_PX);
    const { tag, tone } = nodeLook(agent);
    return {
      id: agent.name,
      position: { x: column * COLUMN_STEP_PX, y },
      data: {
        kind: 'agent',
        file: agent.name,
        role: roleLine(agent),
        tag,
        tone,
        chips: [],
        footer,
      },
    };
  });
}

function edgeSpecs(
  agents: readonly GovernanceAgent[],
  edges: readonly GovernanceEdge[]
): FlowEdgeSpec[] {
  return knownCalls(agents, edges).map(({ source, target }) => ({
    id: `${source}->${target}`,
    source,
    target,
    source_anchor: 'right',
    target_anchor: 'left',
    data: { edge_type: 'call', label: null },
  }));
}

const governanceNodeTestId = (id: string) => `governance-node-${id}`;

const TOOLBAR_PANEL =
  'bg-card/80 rounded-[calc(var(--radius-sm)+0.1875rem)] p-[0.1875rem] shadow-[0_0_0_1px_var(--flow-node-edge),var(--shadow-sm)] backdrop-blur-md backdrop-saturate-150';
const TOOLBAR_BUTTON =
  'text-muted-foreground hover:text-foreground h-7 gap-1.5 px-2.5 text-xs active:scale-[0.96] focus-visible:ring-ring focus-visible:ring-2';

// Both sheets slide over the canvas on the same drawer curve, quicker out than in.
const SHEET_OVERLAY = 'bg-black/25 dark:bg-black/40';
const SHEET_PANEL =
  'w-full gap-0 overflow-y-auto shadow-[var(--shadow-lg)] ease-[cubic-bezier(0.32,0.72,0,1)] data-[state=closed]:duration-200 data-[state=open]:duration-300 motion-reduce:animate-none sm:max-w-md';
const SHEET_HEADER = 'border-border/60 gap-1 border-b px-6 pt-5 pb-4';

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
  const calls = edgeSpecs(agents, edges);
  return (
    <>
      <RefreshError query={query} />
      <div
        ref={setCanvasBox}
        className="border-border/60 relative isolate min-h-[28rem] flex-1 overflow-hidden rounded-lg border"
      >
        {/* The canvas keeps its edges from mount, so a new call between agents remounts it. */}
        <FlowCanvas
          key={calls.map((call) => call.id).join('\n')}
          nodes={layoutNodes(agents, edges)}
          edges={calls}
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
        data-testid="governance-policy-sheet"
      >
        <SheetHeader className={SHEET_HEADER}>
          <SheetTitle className="pr-8 text-base">Scaling policy</SheetTitle>
          <SheetDescription className="text-xs text-pretty">{SCALING_SCOPE}</SheetDescription>
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
        data-testid="governance-drawer"
      >
        <SheetHeader className={SHEET_HEADER}>
          <SheetTitle className="pr-8 font-mono text-base break-all">{agent.name}</SheetTitle>
          <SheetDescription className="text-xs tabular-nums">
            {STATUS_LABEL[agent.status]} · {agent.replicas_running}/{agent.replicas_expected}{' '}
            replicas
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-7 px-6 pt-5">
          <StopAgentButton project_id={project_id} agent={agent} />
          <RulesForm project_id={project_id} agents={agents} agent={agent} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function StopAgentButton({
  project_id,
  agent,
}: {
  readonly project_id: string;
  readonly agent: GovernanceAgent;
}) {
  const set = useSetStopped(project_id, agent.name);
  const stopped = agent.status === 'stopped';
  const warn = agent.scaling_policy_present && !stopped;

  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        type="button"
        size="sm"
        variant={stopped ? 'default' : 'outline'}
        disabled={set.isPending}
        aria-describedby={warn ? 'governance-stop-note' : undefined}
        onClick={() => set.mutate(!stopped)}
      >
        {stopped ? 'Start agent' : 'Stop agent'}
      </Button>
      <ScalingNote warn={warn} />
      <FormError
        error={
          set.error
            ? governanceErrorMessage(
                set.error,
                `Could not ${stopped ? 'start' : 'stop'} the agent.`
              )
            : null
        }
        test_id="governance-stop-error"
      />
    </div>
  );
}

function ScalingNote({ warn }: { readonly warn: boolean }) {
  if (!warn) return null;
  return (
    <p
      id="governance-stop-note"
      className="text-muted-foreground text-xs"
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
  const form = useForm<AgentRules>({
    resolver: zodResolver(AgentRulesSchema),
    values: { requires: agent.rules.requires, spend: agent.rules.spend ?? { rules: [] } },
    resetOptions: { keepDirtyValues: true },
  });
  const rules = useFieldArray({ control: form.control, name: 'spend.rules' });
  const others = agents.filter((other) => other.name !== agent.name).map((other) => other.name);
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
      className="flex flex-col gap-7"
      aria-label={`Rules of ${agent.name}`}
      data-state={save.isPending ? 'saving' : 'editing'}
      onSubmit={submit}
    >
      <section className="flex flex-col gap-3">
        <SectionHeading title="Requires">
          Calls to {agent.name} are refused while any of these has no replica up.
        </SectionHeading>
        <Controller
          control={form.control}
          name="requires"
          render={({ field }) => (
            <RequiresToggle others={others} value={field.value} onChange={field.onChange} />
          )}
        />
        <UnmetRequires unmet={agent.unmet_requires} />
      </section>

      <section className="flex flex-col gap-3">
        <SectionHeading title="Spend rules">The highest threshold passed wins.</SectionHeading>
        <SpendLine agent={agent} />
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Count spend from</span>
            <Controller
              control={form.control}
              name="spend.since"
              render={({ field }) => (
                <Input
                  type="datetime-local"
                  className="w-auto"
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
            onClick={() =>
              form.setValue('spend.since', new Date().toISOString(), { shouldDirty: true })
            }
          >
            From now
          </Button>
        </div>
        <p className="text-muted-foreground text-xs text-pretty">
          Left empty, the stored start is kept; for a new rule the count starts now.
        </p>
        {rules.fields.map((field, index) => (
          <SpendRuleRow
            key={field.id}
            form={form}
            index={index}
            models={agent.models}
            onRemove={() => rules.remove(index)}
          />
        ))}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="self-start"
          onClick={() => rules.append(NEW_RULE)}
        >
          <PlusIcon aria-hidden />
          Add rule
        </Button>
      </section>

      <FormError
        error={save.error ? governanceErrorMessage(save.error, 'Could not save the rules.') : null}
        test_id="governance-form-error"
      />
      <div className="border-border/60 bg-background sticky bottom-0 -mx-6 flex items-center justify-between gap-3 border-t px-6 py-4">
        <p className="text-muted-foreground text-xs">
          Rules apply on the controller&apos;s next poll.
        </p>
        <Button type="submit" size="sm" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save rules'}
        </Button>
      </div>
    </form>
  );
}

function SectionHeading({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-foreground text-[0.8125rem] font-semibold">{title}</h3>
      <p className="text-muted-foreground text-xs text-pretty">{children}</p>
    </div>
  );
}

function RequiresToggle({
  others,
  value,
  onChange,
}: {
  readonly others: readonly string[];
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
      className="flex-wrap justify-start bg-transparent p-0"
      aria-label="Requires"
      value={value}
      onValueChange={onChange}
    >
      {others.map((name) => (
        <ToggleGroupItem key={name} value={name} className="font-mono text-xs">
          {name}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function UnmetRequires({ unmet }: { readonly unmet: readonly string[] }) {
  if (unmet.length === 0) return null;
  return (
    <p className="text-destructive text-xs" data-testid="governance-unmet">
      Not up right now: {unmet.join(', ')}. Calls to this agent are refused.
    </p>
  );
}

function SpendLine({ agent }: { readonly agent: GovernanceAgent }) {
  if (agent.spend === null) return null;
  return (
    <p className="text-foreground font-mono text-xs tabular-nums" data-testid="governance-spend">
      {[...spendParts(agent), ...trippedPart(agent)].join(' · ')}
    </p>
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
      className="border-border/50 bg-muted/30 flex flex-wrap items-end gap-2 rounded-md border p-2.5"
      data-testid="governance-spend-rule"
    >
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Above USD</span>
        <Input
          type="number"
          step="0.01"
          min="0"
          className="w-24"
          aria-invalid={threshold_invalid}
          {...form.register(threshold, { valueAsNumber: true })}
        />
      </label>
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
        className="text-muted-foreground ml-auto"
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
        className="w-44 font-mono"
        placeholder="Model id"
        value={action.model}
        onChange={(event) => onChange({ ...action, model: event.target.value })}
      />
    );
  }
  const options = models.includes(action.model) ? models : [action.model, ...models];
  return (
    <Select value={action.model} onValueChange={(model) => onChange({ ...action, model })}>
      <SelectTrigger aria-label="Model" aria-invalid={invalid} className="w-44 font-mono">
        <SelectValue placeholder="Pick a model" />
      </SelectTrigger>
      <SelectContent>
        {options.filter(Boolean).map((model) => (
          <SelectItem key={model} value={model} className="font-mono">
            {model}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
