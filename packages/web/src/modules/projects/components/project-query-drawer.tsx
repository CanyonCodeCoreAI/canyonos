import { useQuery } from '@tanstack/react-query';
import { ChevronRightIcon } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';

import type { RequestListItem, RequestTrace, RequestTraceBlock } from '@cc-forge/api/requests';

import { CopyButton } from '@repo/ui/components/copy-button';
import { SectionLabel } from '@repo/ui/components/section-label';
import { StatCard } from '@repo/ui/components/stat-card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@repo/ui/shadcn/collapsible';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@repo/ui/shadcn/sheet';
import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { Textarea } from '@repo/ui/shadcn/textarea';
import { cn } from '@repo/ui/utils';
import { apiCall, forgeAuthApi } from '@/api';
import { QueryError } from '@/modules/core/components/QueryError';
import {
  formatBlockCostCents,
  formatDateTime,
  formatDurationMs,
  formatMultiple,
  formatPayload,
  formatQueryCost,
  formatQueryInput,
  formatTokens,
  parseMoney,
  shortRequestId,
} from '@/modules/projects/projects.format';
import { COST_SPLIT } from '@/modules/projects/projects.metrics';
import { projectQueryKeys } from '@/modules/projects/projects.query-cache';

const TEST_ID = 'project-query-drawer';

// The reason a reader opens a query: it cost half again what a query on this project usually does.
const EXPENSIVE_VS_MEDIAN = 1.5;

// A block billing this much of the query is what the reader came to find, so its cost is called out
// rather than left to be spotted in a column.
const EXPENSIVE_BLOCK_SHARE = 0.4;
const TRACE_TICKS = [0, 0.25, 0.5, 0.75, 1] as const;

const traceQuery = (project_id: string, session_id: string) => ({
  queryKey: projectQueryKeys.requestTrace(project_id, session_id),
  queryFn: () =>
    apiCall<RequestTrace>(() => forgeAuthApi.projects[project_id]!.requests[session_id]!.get()),
  retry: false,
});

interface ProjectQueryDrawerProps {
  readonly project_id: string;
  /** `null` closes the drawer. */
  readonly request: RequestListItem | null;
  readonly onClose: () => void;
  /** Focused again on close; without it focus falls to the document body. */
  readonly returnFocusTo?: () => HTMLElement | null;
}

/** One query's trace: what it cost against its peers, and where that money and time went. */
export function ProjectQueryDrawer({
  project_id,
  request,
  onClose,
  returnFocusTo,
}: ProjectQueryDrawerProps) {
  // Held through the close animation, which still runs after `request` is null.
  const [shown_request, setShownRequest] = useState(request);
  if (request !== null && request !== shown_request) setShownRequest(request);

  return (
    <Sheet
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="w-full gap-0 p-0 sm:max-w-[46rem]"
        tabIndex={-1}
        // Default focus lands on the sheet's close button, and the Enter that opened the drawer
        // would then shut it again. Focus the panel instead.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
        // Radix's own restore targets the element captured on open, which a refetch of the listing
        // behind the drawer has since replaced.
        onCloseAutoFocus={(event) => {
          const opener = returnFocusTo?.();
          if (!opener) return;
          event.preventDefault();
          opener.focus();
        }}
        data-testid={TEST_ID}
      >
        {shown_request === null ? null : (
          <QueryDrawerBody project_id={project_id} request={shown_request} />
        )}
      </SheetContent>
    </Sheet>
  );
}

function QueryDrawerBody({
  project_id,
  request,
}: {
  readonly project_id: string;
  readonly request: RequestListItem;
}) {
  const trace_query = useQuery(traceQuery(project_id, request.session_id));
  const short_id = shortRequestId(request.session_id);

  return (
    <>
      {/* `pr-14` keeps the title clear of the sheet's own close button, which floats over this row. */}
      <SheetHeader className="border-border/70 shrink-0 gap-1.5 border-b px-5 py-4 pr-14">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className="size-2 shrink-0 rounded-sm"
            style={{ backgroundColor: COST_SPLIT.harness_cost.color }}
            aria-hidden
          />
          {/* No `id` override: Radix points the dialog's `aria-labelledby` at the one it generates
              for this title, and replacing it leaves the panel with no accessible name at all. */}
          <SheetTitle
            className="min-w-0 truncate font-mono text-[0.9375rem]"
            title={request.session_id}
          >
            {short_id}
          </SheetTitle>
          <CopyButton
            value={request.session_id}
            tooltip="Copy query id"
            className="size-7 shrink-0"
            data-testid={`${TEST_ID}-copy-id`}
          />
        </div>
        <SheetDescription>Request trace and per-block execution costs.</SheetDescription>
      </SheetHeader>

      {/* Focusable because it scrolls: focus opens on the panel, which does not, so without this a
          keyboard reader on a short viewport has nothing to move the trace with. */}
      <div
        className="min-h-0 flex-1 overflow-y-auto px-5 py-5"
        tabIndex={0}
        role="region"
        aria-label={`Query ${short_id} trace`}
      >
        {trace_query.isPending ? <TraceLoading /> : null}
        {trace_query.error ? (
          <QueryError
            message="Could not load this query's trace."
            onRetry={() => void trace_query.refetch()}
            test_id={`${TEST_ID}-error`}
          />
        ) : null}
        {trace_query.data ? <TraceBody trace={trace_query.data} /> : null}
      </div>
    </>
  );
}

function TraceLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy data-testid={`${TEST_ID}-loading`}>
      <section className="flex flex-col gap-2.5">
        <SectionLabel as="h3">This query</SectionLabel>
        <Skeleton className="h-[5.5rem] rounded-2xl" />
        <div className="grid grid-cols-3 gap-2.5">
          {Array.from({ length: 3 }, (_cell, index) => (
            <Skeleton key={index} className="h-[3.375rem] rounded-xl" />
          ))}
        </div>
      </section>
      <Skeleton className="h-40 rounded-xl" />
      <Skeleton className="h-[23rem] rounded-xl" />
    </div>
  );
}

/**
 * How this query compares to a typical one on the project. A median is null when the project billed
 * nothing over the trailing 30 days — the comparison is missing. A zero median is a real reference
 * (a billed project can spend $0 on harness) but supports no multiple, so only the ratio is absent.
 */
function comparison(
  value: number,
  median: number | null,
  format: (value: number) => string
): { readonly ratio: number | null; readonly hint: string } | null {
  if (median === null) return null;
  if (median <= 0) return { ratio: null, hint: `median ${format(median)}` };
  return {
    ratio: value / median,
    hint: `${formatMultiple(value / median)} · median ${format(median)}`,
  };
}

const NO_MEDIAN = 'No median in the last 30 days';

/** The three figures a reader opens a query to judge, each against the project's median. */
function QueryRibbon({ trace }: { readonly trace: RequestTrace }) {
  const cost = comparison(
    parseMoney(trace.total_cost),
    trace.median_cost === null ? null : parseMoney(trace.median_cost),
    (value) => formatQueryCost(value.toFixed(6))
  );
  const tokens = comparison(trace.token_count, trace.median_token_count, (value) =>
    formatTokens(value)
  );
  const harness = comparison(
    parseMoney(trace.harness_cost),
    trace.median_harness_cost === null ? null : parseMoney(trace.median_harness_cost),
    (value) => formatQueryCost(value.toFixed(6))
  );

  return (
    <div
      className="border-border bg-card grid overflow-hidden rounded-2xl border shadow-xs sm:grid-cols-3"
      data-testid={`${TEST_ID}-ribbon`}
    >
      <RibbonCell
        test_id={`${TEST_ID}-ribbon-cost`}
        label="Cost"
        value={formatQueryCost(trace.total_cost)}
        // Called out only when it is the reason the reader opened this query.
        color={
          cost !== null && cost.ratio !== null && cost.ratio >= EXPENSIVE_VS_MEDIAN
            ? 'var(--destructive)'
            : undefined
        }
        hint={cost?.hint ?? NO_MEDIAN}
      />
      <RibbonCell
        test_id={`${TEST_ID}-ribbon-tokens`}
        label="Tokens"
        value={formatTokens(trace.token_count)}
        color={COST_SPLIT.llm_cost.color}
        hint={tokens?.hint ?? NO_MEDIAN}
      />
      <RibbonCell
        test_id={`${TEST_ID}-ribbon-harness`}
        label="Harness & compute"
        value={formatQueryCost(trace.harness_cost)}
        color={COST_SPLIT.harness_cost.color}
        hint={harness?.hint ?? NO_MEDIAN}
      />
    </div>
  );
}

// Mirrors the project ribbon's cell so the drawer reads as the same instrument, one query narrower.
function RibbonCell({
  label,
  value,
  hint,
  color,
  test_id,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint: string;
  readonly color?: string;
  readonly test_id: string;
}) {
  return (
    <div
      className="border-border/70 flex min-w-0 flex-col gap-1.5 px-[1.0625rem] py-[0.9375rem] not-first:border-t sm:not-first:border-t-0 sm:not-first:border-l"
      data-testid={test_id}
    >
      <span className="text-muted-foreground text-[0.65625rem] font-semibold tracking-[0.05em] uppercase">
        {label}
      </span>
      <span
        className={cn(
          'truncate font-mono text-[1.375rem] leading-none font-semibold tracking-[-0.02em] tabular-nums',
          color ? undefined : 'text-foreground'
        )}
        style={color ? { color } : undefined}
      >
        {value}
      </span>
      <span className="text-muted-foreground text-[0.71875rem] leading-snug text-pretty">
        {hint}
      </span>
    </div>
  );
}

function TraceBody({ trace }: { readonly trace: RequestTrace }) {
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2.5" data-testid={`${TEST_ID}-overview`}>
        <SectionLabel as="h3">This query</SectionLabel>
        <QueryRibbon trace={trace} />
        {/* What the ribbon does not carry. Cost, tokens and the median comparisons live there now,
            so repeating them here would say the same thing twice. */}
        <div className="grid grid-cols-3 gap-2.5">
          <StatCard size="compact" label="Created" value={formatDateTime(trace.created_at)} />
          <StatCard size="compact" label="Latency" value={formatDurationMs(trace.duration_ms)} />
          <StatCard
            size="compact"
            label="Retries"
            value={trace.error_count.toLocaleString('en-US')}
          />
        </div>
      </section>

      <section className="border-border/70 flex flex-col gap-2.5 border-t pt-5">
        <SectionLabel as="h3">Where the time and money went</SectionLabel>
        {trace.blocks.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid={`${TEST_ID}-empty`}>
            This query has not reported any block executions yet.
          </p>
        ) : (
          <TraceTimeline trace={trace} />
        )}
      </section>

      <section className="border-border/70 flex flex-col gap-1 border-t pt-5">
        <SectionLabel as="h3">Payloads</SectionLabel>
        <Payload label="Input" test_id={`${TEST_ID}-input`}>
          <Textarea
            value={formatQueryInput(trace.input)}
            readOnly
            rows={3}
            aria-label="Query input"
            className="resize-none text-[0.8125rem] leading-relaxed focus-visible:ring-0"
          />
        </Payload>
        <Payload label="Output" test_id={`${TEST_ID}-output`}>
          <pre className="border-border/70 bg-muted/20 text-secondary-foreground max-h-48 overflow-auto rounded-xl border px-3.5 py-3 font-mono text-[0.75rem] leading-relaxed break-words whitespace-pre-wrap">
            {formatPayload(trace.output)}
          </pre>
        </Payload>
      </section>
    </div>
  );
}

/**
 * A payload pane, closed until asked for. Both panes can run to hundreds of lines, and the reader
 * who came for the cost breakdown should not have to scroll past them to reach it.
 */
function Payload({
  label,
  test_id,
  children,
}: {
  readonly label: string;
  readonly test_id: string;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid={test_id}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          aria-expanded={open}
          data-testid={`${test_id}-toggle`}
          className="text-muted-foreground hover:text-foreground -mx-1.5 flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left transition-colors"
        >
          <ChevronRightIcon
            className={cn(
              'size-3.5 shrink-0 transition-transform duration-150',
              open && 'rotate-90'
            )}
            strokeWidth={2.2}
            aria-hidden
          />
          <span className="text-[0.6875rem] font-semibold tracking-[0.04em] uppercase">
            {label}
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden">
        <div className="pt-1.5 pb-1">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function TraceTimeline({ trace }: { readonly trace: RequestTrace }) {
  const total_duration = Math.max(
    trace.duration_ms ?? 0,
    ...trace.blocks.map((block) => block.started_offset_ms + (block.execution_time_ms ?? 0)),
    1
  );
  return (
    <div className="min-w-0" data-testid={`${TEST_ID}-timeline`}>
      {/* Axis tone matches the cost column rather than the faint muted grey: at 10px the ticks are
          the smallest type in the drawer, and low contrast made the scale unreadable. */}
      <div className="text-secondary-foreground grid grid-cols-[7.375rem_minmax(0,1fr)_4.625rem] items-end text-[0.625rem] font-semibold tracking-[0.04em] uppercase">
        <span>Elapsed →</span>
        <div className="relative h-4 font-mono font-normal tracking-normal normal-case">
          {TRACE_TICKS.map((tick) => (
            <span
              key={tick}
              className="absolute bottom-0 whitespace-nowrap"
              style={{
                left: `${tick * 100}%`,
                transform:
                  tick === 0 ? undefined : tick === 1 ? 'translateX(-100%)' : 'translateX(-50%)',
              }}
            >
              {formatDurationMs(total_duration * tick)}
            </span>
          ))}
        </div>
        <span className="text-right">Cost (¢)</span>
      </div>

      <div className="relative">
        <div className="pointer-events-none absolute inset-y-0 right-[4.625rem] left-[7.375rem] bg-[repeating-linear-gradient(to_right,color-mix(in_srgb,var(--border)_75%,transparent)_0_1px,transparent_1px_25%)]" />
        <div className="relative flex flex-col">
          {trace.blocks.map((block) => (
            <TraceTimelineRow
              key={block.future_id}
              block={block}
              total_duration={total_duration}
              total_cost={parseMoney(trace.total_cost)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function TraceTimelineRow({
  block,
  total_duration,
  total_cost,
}: {
  readonly block: RequestTraceBlock;
  readonly total_duration: number;
  readonly total_cost: number;
}) {
  const duration = block.execution_time_ms ?? 0;
  const left = Math.min(100, (block.started_offset_ms / total_duration) * 100);
  const width = Math.max(0.7, (duration / total_duration) * 100);
  const color = block.kind === 'model' ? COST_SPLIT.llm_cost.color : COST_SPLIT.harness_cost.color;
  const is_expensive =
    total_cost > 0 && parseMoney(block.total_cost) >= EXPENSIVE_BLOCK_SHARE * total_cost;

  return (
    <div className="border-border/40 grid min-h-[2.125rem] grid-cols-[7.375rem_minmax(0,1fr)_4.625rem] items-center border-b last:border-b-0">
      <span className="text-foreground min-w-0 truncate pr-2.5 font-mono text-[0.71875rem] font-medium">
        {block.label}
      </span>
      <div className="relative h-full min-h-[2.125rem]">
        <div
          className="absolute top-1/2 flex h-4 min-w-[3px] -translate-y-1/2 items-center rounded-[4px] px-1.5"
          style={{ left: `${left}%`, width: `${width}%`, backgroundColor: color }}
          title={`${block.label}: ${formatDurationMs(block.execution_time_ms)}`}
        >
          {width >= 14 ? (
            <span className="truncate font-mono text-[0.625rem] text-white">
              {formatDurationMs(block.execution_time_ms)}
            </span>
          ) : null}
        </div>
        {width < 14 ? (
          <span
            className="text-muted-foreground absolute top-1/2 -translate-y-1/2 pl-1.5 font-mono text-[0.625rem] whitespace-nowrap"
            style={{ left: `${Math.min(96, left + width)}%` }}
          >
            {formatDurationMs(block.execution_time_ms)}
          </span>
        ) : null}
      </div>
      <span
        className={`truncate pl-2.5 text-right font-mono text-[0.75rem] font-medium tabular-nums ${is_expensive ? 'text-destructive' : 'text-secondary-foreground'}`}
      >
        {formatBlockCostCents(block.total_cost)}
      </span>
    </div>
  );
}
