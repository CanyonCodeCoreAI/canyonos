// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CalendarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleXIcon,
  ListFilterIcon,
  LoaderCircleIcon,
  XIcon,
} from 'lucide-react';
import { useRef, useState } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { Dispatch, RefObject } from 'react';

import type {
  RequestList,
  RequestListItem,
  RequestSort,
  RequestStatus,
} from '@canyonos/api/requests';

import { Button } from '@repo/ui/shadcn/button';
import { Calendar } from '@repo/ui/shadcn/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/shadcn/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@repo/ui/shadcn/select';
import { Skeleton } from '@repo/ui/shadcn/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@repo/ui/shadcn/table';
import { cn } from '@repo/ui/utils';
import { EmptyState } from '@/modules/core/components/EmptyState';
import { QueryError } from '@/modules/core/components/QueryError';
import { rangeLabel } from '@/modules/core/time-range';
import { ProjectMetricsSection } from '@/modules/projects/components/project-metrics-section';
import { ProjectQueryDrawer } from '@/modules/projects/components/project-query-drawer';
import {
  formatDateTime,
  formatDay,
  formatDurationMs,
  formatMoney,
  formatPageRange,
  shortRequestId,
} from '@/modules/projects/projects.format';
import {
  DEFAULT_REQUESTS_ORDER,
  nextRequestsOrder,
  requestDayBounds,
  selectableDayRange,
} from '@/modules/projects/projects.metrics';
import { projectRequestsQueryOptions } from '@/modules/projects/projects.queries';
import { rangeParams } from '@/modules/projects/projects.query-cache';
import type { RangeSelection } from '@/modules/core/time-range';
import type { OpenedQuery } from '@/modules/projects/components/project-query-drawer';
import type { DistributionSelection, RequestsPage } from '@/modules/projects/projects.metrics';
import type { RequestsQuery } from '@/modules/projects/projects.queries';

const PAGE_SIZE = 5;

// A full page is the tallest this listing ever gets (5 rows of 50px over a 48px header, each ruled
// by a 1px border). Reserving it keeps the section the same height while it loads, when a day comes
// back empty, and on a short last page — paging must not move the rest of the screen.
const TABLE_REGION_HEIGHT = 'min-h-[19rem]';

const STATUS_BADGE: Record<RequestStatus, { label: string }> = {
  running: { label: 'Running' },
  completed: { label: 'Completed' },
  failed: { label: 'Failed' },
};

const STATUS_ICON_TONE: Record<RequestStatus, string> = {
  running: 'text-chart-2',
  completed: 'text-primary',
  failed: 'text-destructive',
};

const STATUS_ICON_SURFACE: Record<RequestStatus, string> = {
  running: 'bg-chart-2/10',
  completed: 'bg-primary/10',
  failed: 'bg-destructive/10',
};

const STATUS_FILTER_OPTIONS: readonly { value: RequestStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'Status' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
];

const COLUMNS = [
  { label: 'Status', sort: null, description: null, numeric: false, filter: 'status' },
  { label: 'Query', sort: null, description: null, numeric: false, filter: null },
  {
    label: 'Created',
    sort: 'created_at',
    description: 'when it was created',
    numeric: false,
    filter: null,
  },
  { label: 'Cost', sort: 'total_cost', description: 'cost', numeric: true, filter: null },
  { label: 'Latency', sort: 'duration_ms', description: 'latency', numeric: true, filter: null },
] as const satisfies readonly {
  label: string;
  sort: RequestSort | null;
  description: string | null;
  numeric: boolean;
  filter: 'status' | null;
}[];

const HEADER_CELL = 'text-muted-foreground h-auto';
const HEADER_LABEL = 'text-[0.65625rem] font-semibold tracking-[0.05em] uppercase';
const HEADER_PADDING = 'px-3 py-2.5';
const NUMERIC_CELL = 'px-3 py-[0.6875rem] text-right font-mono text-[0.78125rem] tabular-nums';

export interface RequestsTableState {
  readonly page: RequestsPage;
  readonly status_filter: RequestStatus | 'all';
  readonly selected_day: Date | null;
  readonly opened: OpenedQuery | null;
}

export type RequestsTableAction =
  | { readonly type: 'sort'; readonly column: RequestSort }
  | { readonly type: 'status-filter'; readonly status_filter: RequestStatus | 'all' }
  | { readonly type: 'day-filter'; readonly day: Date | null }
  | { readonly type: 'page-offset'; readonly offset: number }
  | { readonly type: 'open-request'; readonly opened: OpenedQuery }
  | { readonly type: 'close-request' };

export const INITIAL_REQUESTS_TABLE: RequestsTableState = {
  page: { limit: PAGE_SIZE, offset: 0, ...DEFAULT_REQUESTS_ORDER },
  status_filter: 'all',
  selected_day: null,
  opened: null,
};

export function requestsTableReducer(
  state: RequestsTableState,
  action: RequestsTableAction
): RequestsTableState {
  switch (action.type) {
    case 'sort':
      return {
        ...state,
        page: { ...state.page, offset: 0, ...nextRequestsOrder(state.page, action.column) },
      };
    case 'status-filter':
      return {
        ...state,
        status_filter: action.status_filter,
        page: { ...state.page, offset: 0 },
      };
    case 'day-filter':
      return { ...state, selected_day: action.day, page: { ...state.page, offset: 0 } };
    case 'page-offset':
      return { ...state, page: { ...state.page, offset: action.offset } };
    case 'open-request':
      return { ...state, opened: action.opened };
    case 'close-request':
      return { ...state, opened: null };
  }
}

interface ProjectRequestsTableProps {
  readonly project_id: string;
  readonly range: RangeSelection;
  readonly selection?: DistributionSelection | null;
  /** Held by the panel, which also moves the page back to the start when the selection changes. */
  readonly state: RequestsTableState;
  readonly dispatch: Dispatch<RequestsTableAction>;
}

export function ProjectRequestsTable({
  project_id,
  range,
  selection,
  state,
  dispatch,
}: ProjectRequestsTableProps) {
  const table_ref = useRef<HTMLDivElement>(null);
  const opened_session_id = useRef<string | null>(null);

  const { page, selected_day, opened, status_filter } = state;
  const status = status_filter === 'all' ? undefined : status_filter;
  const query: RequestsQuery = {
    range,
    ...page,
    status,
    metric: selection?.metric,
    min: selection?.min,
    max: selection?.max,
    ...(selected_day ? requestDayBounds(selected_day) : {}),
  };
  const requests_query = useQuery({
    ...projectRequestsQueryOptions(project_id, query),
    placeholderData: keepPreviousData,
  });
  const sortBy = (column: RequestSort) => dispatch({ type: 'sort', column });
  const filterByStatus = (status_filter: RequestStatus | 'all') =>
    dispatch({ type: 'status-filter', status_filter });
  const filterByDay = (day: Date | null) => dispatch({ type: 'day-filter', day });

  const status_label = status === undefined ? null : STATUS_BADGE[status].label;
  const day_label = selected_day ? formatDay(selected_day) : null;

  return (
    <>
      <ProjectMetricsSection
        title={queriesTitle(range, selection, day_label, status_label)}
        className="p-5"
        description={queriesDescription(selection, day_label)}
        test_id="project-queries"
        action={<QueriesDayFilter value={selected_day} query={query} onChange={filterByDay} />}
        footer={
          <div className="flex min-h-9 flex-col justify-center">
            <Pager
              listed={requests_query.data}
              offset={page.offset}
              selection={selection}
              day_label={day_label}
              onOffsetChange={(offset) => dispatch({ type: 'page-offset', offset })}
            />
          </div>
        }
      >
        <QueriesBody
          query={requests_query}
          table_ref={table_ref}
          page={page}
          status_filter={status_filter}
          selection={selection}
          day_label={day_label}
          onSort={sortBy}
          onStatusChange={filterByStatus}
          onRetry={() => void requests_query.refetch()}
          onSelect={(opened) => {
            opened_session_id.current = opened.session_id;
            dispatch({ type: 'open-request', opened });
          }}
        />
      </ProjectMetricsSection>
      <ProjectQueryDrawer
        project_id={project_id}
        opened={opened}
        onClose={() => dispatch({ type: 'close-request' })}
        // Resolved at close, not captured at open: refreshing the listing rebuilds its rows and
        // detaches the one that was clicked.
        returnFocusTo={() => {
          const session_id = opened_session_id.current;
          if (!session_id) return null;
          return (
            table_ref.current?.querySelector<HTMLElement>(
              `[data-testid="project-query-open-${session_id}"]`
            ) ?? null
          );
        }}
      />
    </>
  );
}

function QueriesBody({
  query,
  table_ref,
  page,
  status_filter,
  selection,
  day_label,
  onSort,
  onStatusChange,
  onRetry,
  onSelect,
}: {
  readonly query: UseQueryResult<RequestList>;
  readonly table_ref: RefObject<HTMLDivElement | null>;
  readonly page: RequestsPage;
  readonly status_filter: RequestStatus | 'all';
  readonly selection?: DistributionSelection | null;
  readonly day_label: string | null;
  readonly onSort: (column: RequestSort) => void;
  readonly onStatusChange: (status: RequestStatus | 'all') => void;
  readonly onRetry: () => void;
  readonly onSelect: (opened: OpenedQuery) => void;
}) {
  const items = query.data?.items ?? [];

  if (query.error) {
    return (
      <div className={cn('flex flex-col', TABLE_REGION_HEIGHT)} data-testid="project-queries-body">
        <QueryError
          message="Could not load this project's queries."
          onRetry={onRetry}
          className="my-auto"
          test_id="project-queries-error"
        />
      </div>
    );
  }

  if (!query.isPending && items.length === 0) {
    return (
      <div className={cn('flex flex-col', TABLE_REGION_HEIGHT)} data-testid="project-queries-body">
        <EmptyState size="section" className="my-auto" test_id="project-queries-empty">
          <p>{emptyQueriesMessage(selection, day_label)}</p>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col', TABLE_REGION_HEIGHT)} data-testid="project-queries-body">
      <div ref={table_ref} className="min-w-0 overflow-x-auto" data-testid="project-queries-table">
        <Table className="min-w-[42rem] table-fixed">
          <colgroup>
            <col className="w-14" />
            <col />
            <col />
            <col />
            <col />
          </colgroup>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              {COLUMNS.map((column) => (
                <SortableHeader
                  key={column.label}
                  column={column}
                  page={page}
                  status_filter={status_filter}
                  onSort={onSort}
                  onStatusChange={onStatusChange}
                />
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.data === undefined ? (
              <SkeletonRows />
            ) : (
              <ListedRows listed={query.data} onSelect={onSelect} />
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function SkeletonRows() {
  return Array.from({ length: PAGE_SIZE }, (_row, row_index) => (
    <TableRow key={row_index} className="border-border/60 hover:bg-transparent">
      {COLUMNS.map((column) => (
        <TableCell key={column.label} className="px-3 py-[0.6875rem]">
          <Skeleton
            className={column.filter === 'status' ? 'size-7 rounded-full' : 'h-3.5 w-full'}
          />
        </TableCell>
      ))}
    </TableRow>
  ));
}

function ListedRows({
  listed,
  onSelect,
}: {
  readonly listed: RequestList;
  readonly onSelect: (opened: OpenedQuery) => void;
}) {
  const range = { from: listed.from, to: listed.to };
  return listed.items.map((request) => (
    <RequestRow
      key={request.session_id}
      request={request}
      onSelect={() => onSelect({ session_id: request.session_id, range })}
    />
  ));
}

function emptyQueriesMessage(
  selection: DistributionSelection | null | undefined,
  day_label: string | null
): string {
  if (selection) return `No queries landed in this range${day_label ? ` on ${day_label}` : ''}.`;
  if (day_label) return `No queries on ${day_label}.`;
  return 'This project has not served any queries yet.';
}

function queriesDescription(
  selection: DistributionSelection | null | undefined,
  day_label: string | null
): string | undefined {
  if (selection) {
    return `The queries that landed in the selected bar${day_label ? ` on ${day_label}` : ''}. Click it again to see them all.`;
  }
  if (day_label) return `Only the queries created on ${day_label}. Clear the day to see them all.`;
  return undefined;
}

// Every active filter names itself, or the count under the table reads as the whole project.
function queriesTitle(
  range: RangeSelection,
  selection: DistributionSelection | null | undefined,
  day_label: string | null,
  status_label: string | null
): string {
  const scope = `Queries · ${rangeLabel(range)}`;
  const facets = [selection?.label ?? null, day_label, status_label].filter(
    (facet) => facet !== null
  );
  return facets.length === 0 ? scope : `${scope} · ${facets.join(' · ')}`;
}

function QueriesDayFilter({
  value,
  query,
  onChange,
}: {
  readonly value: Date | null;
  readonly query: RequestsQuery;
  readonly onChange: (day: Date | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger_ref = useRef<HTMLButtonElement>(null);
  const { from, to } = selectableDayRange(rangeParams(query.range));
  const range_label = rangeLabel(query.range);
  const label = value
    ? `Filter queries by day: ${formatDay(value)}`
    : `Filter queries by day, showing ${range_label}`;

  return (
    <div className="flex items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            ref={trigger_ref}
            variant="outline"
            size="sm"
            aria-label={label}
            title={label}
            className={cn('gap-1.5 text-xs', value !== null && 'text-primary')}
            data-testid="project-queries-calendar"
          >
            <CalendarIcon className="size-3.5" strokeWidth={2.1} aria-hidden />
            {value ? formatDay(value) : range_label}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" aria-label="Choose a day" className="w-auto p-0">
          <Calendar
            mode="single"
            autoFocus
            selected={value ?? undefined}
            defaultMonth={value ?? to}
            startMonth={from}
            endMonth={to}
            disabled={[{ before: from }, { after: to }]}
            onSelect={(day) => {
              onChange(day ?? null);
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
      <ClearDayButton
        value={value}
        onClear={() => {
          onChange(null);
          trigger_ref.current?.focus();
        }}
      />
    </div>
  );
}

function ClearDayButton({
  value,
  onClear,
}: {
  readonly value: Date | null;
  readonly onClear: () => void;
}) {
  if (value === null) return null;
  return (
    <button
      type="button"
      onClick={onClear}
      aria-label="Clear the day filter"
      title="Clear the day filter"
      className="text-muted-foreground focus-visible:ring-ring inline-flex h-9 items-center justify-center rounded-md px-2 focus-visible:ring-2 focus-visible:outline-none"
      data-testid="project-queries-calendar-reset"
    >
      <XIcon className="size-3.5" strokeWidth={2.1} aria-hidden />
    </button>
  );
}

function SortableHeader({
  column,
  page,
  status_filter,
  onSort,
  onStatusChange,
}: {
  readonly column: (typeof COLUMNS)[number];
  readonly page: RequestsPage;
  readonly status_filter: RequestStatus | 'all';
  readonly onSort: (column: RequestSort) => void;
  readonly onStatusChange: (status: RequestStatus | 'all') => void;
}) {
  const active = column.sort !== null && page.sort === column.sort;
  const ascending = page.order === 'asc';

  if (column.filter === 'status') {
    return (
      <TableHead
        className={cn(HEADER_CELL, HEADER_LABEL, HEADER_PADDING, column.numeric && 'text-right')}
      >
        <StatusFilter value={status_filter} onChange={onStatusChange} />
      </TableHead>
    );
  }

  if (column.sort === null) {
    return (
      <TableHead
        className={cn(HEADER_CELL, HEADER_LABEL, HEADER_PADDING, column.numeric && 'text-right')}
        data-testid={`project-queries-column-${column.label.toLowerCase()}`}
      >
        {column.label}
      </TableHead>
    );
  }

  const sort_key = column.sort;
  return (
    <TableHead
      aria-sort={active ? (ascending ? 'ascending' : 'descending') : 'none'}
      className={cn(HEADER_CELL, 'p-0')}
      data-testid={`project-queries-column-${sort_key}`}
    >
      <button
        type="button"
        onClick={() => onSort(sort_key)}
        className={cn(
          HEADER_LABEL,
          HEADER_PADDING,
          'hover:text-foreground focus-visible:ring-ring flex w-full cursor-pointer items-center gap-1 transition-colors focus-visible:ring-2 focus-visible:outline-none',
          active && 'text-foreground',
          column.numeric && 'justify-end'
        )}
        aria-label={
          active
            ? `Sorted by ${column.description}, ${ascending ? 'lowest' : 'highest'} first. Reverse the order`
            : `Sort by ${column.description}`
        }
      >
        {column.label}
        <span className="inline-flex w-3 justify-center" aria-hidden>
          <SortArrow active={active} ascending={ascending} />
        </span>
      </button>
    </TableHead>
  );
}

function SortArrow({
  active,
  ascending,
}: {
  readonly active: boolean;
  readonly ascending: boolean;
}) {
  if (!active) return null;
  const Arrow = ascending ? ArrowUpIcon : ArrowDownIcon;
  return <Arrow className="size-3" strokeWidth={2.4} />;
}

function StatusFilter({
  value,
  onChange,
}: {
  readonly value: RequestStatus | 'all';
  readonly onChange: (value: RequestStatus | 'all') => void;
}) {
  const label =
    value === 'all'
      ? 'Filter queries by status'
      : `Filter queries by status: ${STATUS_BADGE[value].label}`;

  return (
    <Select value={value} onValueChange={(next) => onChange(next as RequestStatus | 'all')}>
      <SelectTrigger
        aria-label={label}
        title={label}
        className={cn(
          HEADER_LABEL,
          'text-muted-foreground hover:text-foreground relative size-7 justify-center rounded-md border-0 bg-transparent p-0 shadow-none focus-visible:ring-2 focus-visible:ring-offset-0 [&>svg:last-child]:hidden',
          value !== 'all' && 'text-primary hover:text-primary'
        )}
        data-testid="project-queries-status-filter"
      >
        <SelectValue>
          <ListFilterIcon className="size-4" strokeWidth={2.1} aria-hidden />
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        {STATUS_FILTER_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label === 'Status' ? 'All statuses' : option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function StatusGlyph({ status }: { readonly status: RequestStatus }) {
  if (status === 'running') {
    return (
      <LoaderCircleIcon
        className="size-4 animate-spin motion-reduce:animate-none"
        strokeWidth={2.1}
        aria-hidden
      />
    );
  }

  if (status === 'completed') {
    return <CircleCheckIcon className="size-4" strokeWidth={2.1} aria-hidden />;
  }

  return <CircleXIcon className="size-4" strokeWidth={2.1} aria-hidden />;
}

function Pager({
  listed,
  offset,
  selection,
  day_label,
  onOffsetChange,
}: {
  readonly listed: RequestList | undefined;
  readonly offset: number;
  readonly selection?: DistributionSelection | null;
  readonly day_label: string | null;
  readonly onOffsetChange: (offset: number) => void;
}) {
  if (listed === undefined || listed.total === 0) return null;
  const { total } = listed;
  const shown = listed.items.length;

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <p className="text-muted-foreground text-[0.71875rem]" data-testid="project-queries-count">
        {formatPageRange(offset, shown, total)} {total === 1 ? 'query' : 'queries'}
        {selection ? ' in this range' : ''}
        {day_label ? ` on ${day_label}` : ''}
      </p>
      <PagerButtons offset={offset} shown={shown} total={total} onOffsetChange={onOffsetChange} />
    </div>
  );
}

function PagerButtons({
  offset,
  shown,
  total,
  onOffsetChange,
}: {
  readonly offset: number;
  readonly shown: number;
  readonly total: number;
  readonly onOffsetChange: (offset: number) => void;
}) {
  const has_previous = offset > 0;
  const has_next = offset + shown < total;
  if (!has_previous && !has_next) return null;

  return (
    <div className="flex items-center gap-1.5" data-testid="project-queries-pager">
      <Button
        variant="outline"
        size="sm"
        disabled={!has_previous}
        onClick={() => onOffsetChange(Math.max(0, offset - PAGE_SIZE))}
        className="gap-1 text-xs"
        data-testid="project-queries-previous"
      >
        <ChevronLeftIcon className="size-3.5" strokeWidth={2.1} aria-hidden />
        Previous
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={!has_next}
        onClick={() => onOffsetChange(offset + PAGE_SIZE)}
        className="gap-1 text-xs"
        data-testid="project-queries-next"
      >
        Next
        <ChevronRightIcon className="size-3.5" strokeWidth={2.1} aria-hidden />
      </Button>
    </div>
  );
}

function RequestRow({
  request,
  onSelect,
}: {
  readonly request: RequestListItem;
  readonly onSelect: () => void;
}) {
  const short_id = shortRequestId(request.session_id);

  return (
    <TableRow
      // The id button stretches an overlay across the row, so a click anywhere is the same event
      // while the row stays a row of cells to a screen reader. Same pattern as the block drawer.
      className="border-border/60 hover:bg-muted/40 has-[button:focus-visible]:ring-ring relative has-[button:focus-visible]:ring-2 has-[button:focus-visible]:ring-inset"
      data-testid={`project-query-${request.session_id}`}
    >
      <TableCell className="px-3 py-[0.6875rem]">
        <span
          role="img"
          aria-label={STATUS_BADGE[request.status].label}
          title={STATUS_BADGE[request.status].label}
          className={cn(
            'inline-flex size-7 items-center justify-center rounded-full',
            STATUS_ICON_SURFACE[request.status],
            STATUS_ICON_TONE[request.status]
          )}
        >
          <StatusGlyph status={request.status} />
        </span>
      </TableCell>
      <TableCell className="px-3 py-[0.6875rem]">
        <button
          type="button"
          onClick={onSelect}
          aria-label={`Open query ${short_id}`}
          title={request.session_id}
          className="text-link block min-w-0 truncate text-left font-mono text-[0.75rem] font-semibold after:absolute after:inset-0 after:z-[1] after:content-[''] focus-visible:outline-none"
          data-testid={`project-query-open-${request.session_id}`}
        >
          {short_id}
        </button>
      </TableCell>
      <TableCell className="px-3 py-[0.6875rem]">
        <time
          className="text-secondary-foreground block truncate text-[0.75rem]"
          dateTime={request.created_at}
          title={request.created_at}
        >
          {formatDateTime(request.created_at)}
        </time>
      </TableCell>
      <TableCell className="px-3 py-[0.6875rem]">
        <span className="text-foreground block text-right font-mono text-[0.78125rem] font-semibold tabular-nums">
          {formatMoney(request.total_cost)}
        </span>
      </TableCell>
      <TableCell className={`${NUMERIC_CELL} text-secondary-foreground`}>
        {formatDurationMs(request.duration_ms)}
      </TableCell>
    </TableRow>
  );
}
