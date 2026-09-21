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
import { Fragment, useId, useReducer, useRef, useState } from 'react';
import type { RefObject } from 'react';

import type { MetricsWindow } from '@canyonos/api/metrics';
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
import { apiCall, forgeAuthApi } from '@/api';
import { EmptyState } from '@/modules/core/components/EmptyState';
import { QueryError } from '@/modules/core/components/QueryError';
import {
  AnalyzeButton,
  AnalyzePreviewNote,
} from '@/modules/projects/components/project-analyze-button';
import { ProjectMetricsSection } from '@/modules/projects/components/project-metrics-section';
import { ProjectQueryDrawer } from '@/modules/projects/components/project-query-drawer';
import {
  formatCount,
  formatDateTime,
  formatDay,
  formatDurationMs,
  formatMoney,
  formatPageRange,
  shortRequestId,
} from '@/modules/projects/projects.format';
import {
  DEFAULT_REQUESTS_ORDER,
  metricsWindowLabel,
  nextRequestsOrder,
  requestDayBounds,
  selectableDayRange,
} from '@/modules/projects/projects.metrics';
import { dashboardPollInterval, projectQueryKeys } from '@/modules/projects/projects.query-cache';
import type {
  DistributionSelection,
  RequestListFilters,
  RequestsPage,
} from '@/modules/projects/projects.metrics';

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

interface ListedRequestScope {
  readonly selection_key: string;
  readonly time_window: MetricsWindow;
}

interface RequestsTableState {
  readonly page: RequestsPage;
  readonly status_filter: RequestStatus | 'all';
  readonly selected_day: Date | null;
  readonly selected_request: RequestListItem | null;
  readonly listed: ListedRequestScope;
}

type RequestsTableAction =
  | { readonly type: 'sort'; readonly column: RequestSort }
  | { readonly type: 'status-filter'; readonly status_filter: RequestStatus | 'all' }
  | { readonly type: 'day-filter'; readonly day: Date | null }
  | { readonly type: 'page-offset'; readonly offset: number }
  | { readonly type: 'select-request'; readonly request: RequestListItem }
  | { readonly type: 'close-request' }
  | { readonly type: 'scope-changed'; readonly scope: ListedRequestScope };

function requestsTableInitialState(listed: ListedRequestScope): RequestsTableState {
  return {
    page: { limit: PAGE_SIZE, offset: 0, ...DEFAULT_REQUESTS_ORDER },
    status_filter: 'all',
    selected_day: null,
    selected_request: null,
    listed,
  };
}

function requestsTableReducer(
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
    case 'select-request':
      return { ...state, selected_request: action.request };
    case 'close-request':
      return { ...state, selected_request: null };
    case 'scope-changed': {
      const time_window_changed = state.listed.time_window !== action.scope.time_window;
      return {
        ...state,
        page: { ...state.page, offset: 0 },
        selected_day: time_window_changed ? null : state.selected_day,
        listed: action.scope,
      };
    }
  }
}

interface ProjectRequestsTableProps {
  readonly project_id: string;
  readonly time_window: MetricsWindow;
  readonly selection?: DistributionSelection | null;
}

export function ProjectRequestsTable({
  project_id,
  time_window,
  selection,
}: ProjectRequestsTableProps) {
  const table_ref = useRef<HTMLDivElement>(null);
  const preview_id = useId();
  const opened_session_id = useRef<string | null>(null);

  const listed_scope = { selection_key: selection?.bucket_key ?? 'all', time_window };
  const [state, dispatch] = useReducer(
    requestsTableReducer,
    listed_scope,
    requestsTableInitialState
  );
  if (
    state.listed.selection_key !== listed_scope.selection_key ||
    state.listed.time_window !== listed_scope.time_window
  ) {
    dispatch({ type: 'scope-changed', scope: listed_scope });
  }

  const { page, selected_day, selected_request, status_filter } = state;
  const status = status_filter === 'all' ? undefined : status_filter;
  const filters: RequestListFilters = {
    time_window,
    status,
    selection,
    day: selected_day ? requestDayBounds(selected_day) : null,
  };
  const requests_query = useQuery({
    queryKey: projectQueryKeys.requests(project_id, page, filters),
    queryFn: () =>
      apiCall<RequestList>(() =>
        forgeAuthApi.projects[project_id]!.requests.get({
          $query: {
            limit: page.limit,
            offset: page.offset,
            sort: page.sort,
            order: page.order,
            ...(status ? { status } : {}),
            time_window,
            ...(filters.day ?? {}),
            ...(selection
              ? {
                  metric: selection.metric,
                  time_window: selection.time_window,
                  min: selection.min,
                  max: selection.max,
                }
              : {}),
          },
        })
      ),
    placeholderData: keepPreviousData,
    retry: false,
    refetchInterval: dashboardPollInterval,
  });
  const total = requests_query.data?.total ?? 0;
  const shown = requests_query.data?.items.length ?? 0;

  const sortBy = (column: RequestSort) => dispatch({ type: 'sort', column });
  const filterByStatus = (status_filter: RequestStatus | 'all') =>
    dispatch({ type: 'status-filter', status_filter });
  const filterByDay = (day: Date | null) => dispatch({ type: 'day-filter', day });

  const status_label = status === undefined ? null : STATUS_BADGE[status].label;
  const day_label = selected_day ? formatDay(selected_day) : null;

  return (
    <>
      <ProjectMetricsSection
        title={queriesTitle(time_window, selection, day_label, status_label)}
        className="p-5"
        description={
          selection
            ? `The queries that landed in the selected bar${day_label ? ` on ${day_label}` : ''}. Click it again to see them all.`
            : day_label
              ? `Only the queries created on ${day_label}. Clear the day to see them all.`
              : undefined
        }
        test_id="project-queries"
        action={
          <QueriesDayFilter value={selected_day} time_window={time_window} onChange={filterByDay} />
        }
        footer={
          <Fragment>
            {selection?.analyzable && total > 0 ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <AnalyzeButton
                  subject={`the ${formatCount(total)} queries in ${selection.label}`}
                  describedBy={preview_id}
                  test_id="project-queries-analyze"
                />
                <AnalyzePreviewNote id={preview_id} className="px-0" />
              </div>
            ) : null}
            <div className="flex min-h-9 flex-col justify-center">
              {requests_query.data && total > 0 ? (
                <Pager
                  offset={page.offset}
                  shown={shown}
                  total={total}
                  selection={selection}
                  day_label={day_label}
                  onOffsetChange={(offset) => dispatch({ type: 'page-offset', offset })}
                />
              ) : null}
            </div>
          </Fragment>
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
          onSelect={(request) => {
            opened_session_id.current = request.session_id;
            dispatch({ type: 'select-request', request });
          }}
        />
      </ProjectMetricsSection>
      <ProjectQueryDrawer
        project_id={project_id}
        request={selected_request}
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
  readonly query: {
    readonly data: RequestList | undefined;
    readonly error: unknown;
    readonly isPending: boolean;
  };
  readonly table_ref: RefObject<HTMLDivElement | null>;
  readonly page: RequestsPage;
  readonly status_filter: RequestStatus | 'all';
  readonly selection?: DistributionSelection | null;
  readonly day_label: string | null;
  readonly onSort: (column: RequestSort) => void;
  readonly onStatusChange: (status: RequestStatus | 'all') => void;
  readonly onRetry: () => void;
  readonly onSelect: (request: RequestListItem) => void;
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
            {query.isPending
              ? Array.from({ length: PAGE_SIZE }, (_row, row_index) => (
                  <TableRow key={row_index} className="border-border/60 hover:bg-transparent">
                    {COLUMNS.map((column) => (
                      <TableCell key={column.label} className="px-3 py-[0.6875rem]">
                        {column.filter === 'status' ? (
                          <Skeleton className="size-7 rounded-full" />
                        ) : (
                          <Skeleton className="h-3.5 w-full" />
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : items.map((request) => (
                  <RequestRow key={request.session_id} request={request} onSelect={onSelect} />
                ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function emptyQueriesMessage(
  selection: DistributionSelection | null | undefined,
  day_label: string | null
): string {
  if (selection) return `No queries landed in this range${day_label ? ` on ${day_label}` : ''}.`;
  if (day_label) return `No queries on ${day_label}.`;
  return 'This project has not served any queries yet.';
}

// Every active filter names itself, or the count under the table reads as the whole project.
function queriesTitle(
  time_window: MetricsWindow,
  selection: DistributionSelection | null | undefined,
  day_label: string | null,
  status_label: string | null
): string {
  const scope = selection
    ? `Queries in ${selection.label}`
    : `Queries · ${metricsWindowLabel(time_window)}`;
  const facets = [day_label, status_label].filter((facet) => facet !== null);
  return facets.length === 0 ? scope : `${scope} · ${facets.join(' · ')}`;
}

function QueriesDayFilter({
  value,
  time_window,
  onChange,
}: {
  readonly value: Date | null;
  readonly time_window: MetricsWindow;
  readonly onChange: (day: Date | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger_ref = useRef<HTMLButtonElement>(null);
  const { from, to } = selectableDayRange(time_window);
  const window_label = metricsWindowLabel(time_window);
  const label = value
    ? `Filter queries by day: ${formatDay(value)}`
    : `Filter queries by day, showing ${window_label}`;

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
            {value ? formatDay(value) : window_label}
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
      {value ? (
        <button
          type="button"
          onClick={() => {
            onChange(null);
            trigger_ref.current?.focus();
          }}
          aria-label="Clear the day filter"
          title="Clear the day filter"
          className="text-muted-foreground focus-visible:ring-ring inline-flex h-9 items-center justify-center rounded-md px-2 focus-visible:ring-2 focus-visible:outline-none"
          data-testid="project-queries-calendar-reset"
        >
          <XIcon className="size-3.5" strokeWidth={2.1} aria-hidden />
        </button>
      ) : null}
    </div>
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
          {active ? (
            ascending ? (
              <ArrowUpIcon className="size-3" strokeWidth={2.4} />
            ) : (
              <ArrowDownIcon className="size-3" strokeWidth={2.4} />
            )
          ) : null}
        </span>
      </button>
    </TableHead>
  );
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
  offset,
  shown,
  total,
  selection,
  day_label,
  onOffsetChange,
}: {
  readonly offset: number;
  readonly shown: number;
  readonly total: number;
  readonly selection?: DistributionSelection | null;
  readonly day_label: string | null;
  readonly onOffsetChange: (offset: number) => void;
}) {
  const has_previous = offset > 0;
  const has_next = offset + shown < total;

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <p className="text-muted-foreground text-[0.71875rem]" data-testid="project-queries-count">
        {formatPageRange(offset, shown, total)} {total === 1 ? 'query' : 'queries'}
        {selection ? ' in this range' : ''}
        {day_label ? ` on ${day_label}` : ''}
      </p>
      {has_previous || has_next ? (
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
      ) : null}
    </div>
  );
}

function RequestRow({
  request,
  onSelect,
}: {
  readonly request: RequestListItem;
  readonly onSelect: (request: RequestListItem) => void;
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
          onClick={() => onSelect(request)}
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
