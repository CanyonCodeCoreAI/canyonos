// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { CalendarIcon } from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import { TimeRangeToggle } from '@repo/ui/components/time-range-toggle';
import { Button } from '@repo/ui/shadcn/button';
import { Calendar } from '@repo/ui/shadcn/calendar';
import { Input } from '@repo/ui/shadcn/input';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@repo/ui/shadcn/popover';
import { cn } from '@repo/ui/utils';
import { HeaderDockPortal } from '@/modules/core/navigation/header-dock';
import {
  isRangePreset,
  RANGE_PRESETS,
  rangeLabel,
  rangeSelectionFromSearch,
} from '@/modules/core/time-range';
import { rangedQueries } from '@/modules/projects/projects.query-cache';
import type { TimeRange } from '@/modules/core/time-range';

const PROJECT_ROUTE = '/_authenticated/projects/$project_id';

/**
 * The metrics window toggle, always in the app header so it stays in reach however far the page
 * scrolls. The window itself is the route's `range` or `from`/`to` search params, so it survives
 * reloads and links.
 */
export function ProjectWindowControl() {
  const value = rangeSelectionFromSearch(useSearch({ from: PROJECT_ROUTE }));
  const { project_id } = useParams({ from: PROJECT_ROUTE });
  const navigate = useNavigate();
  const query_client = useQueryClient();

  return (
    <HeaderDockPortal>
      <div className="flex items-center gap-2">
        <CustomRangePicker
          value={'preset' in value ? null : value}
          onApply={(next) => {
            void navigate({
              to: '.',
              search: (previous) => ({ ...previous, from: next.from, to: next.to }),
            });
          }}
        />
        <TimeRangeToggle
          value={'preset' in value ? value.preset : ''}
          onValueChange={(next) => {
            if (!isRangePreset(next)) return;
            void navigate({
              to: '.',
              search: (previous) => ({
                ...previous,
                range: next,
                from: undefined,
                to: undefined,
              }),
            });
          }}
          onReselect={() => void query_client.invalidateQueries(rangedQueries(project_id))}
          options={RANGE_PRESETS}
          aria-label="Time range"
          data-testid="project-window-toggle"
          className="p-0.5"
        />
      </div>
    </HeaderDockPortal>
  );
}

const MINUTE_MS = 60_000;

const timeOf = (at: Date) => at.toTimeString().slice(0, 5);

const atTime = (day: Date, time: string): Date => {
  const [hours, minutes] = time.split(':').map(Number);
  const at = new Date(day);
  at.setHours(hours!, minutes!, 0, 0);
  return at;
};

const isToday = (day: Date) => day.toDateString() === new Date().toDateString();

const TimeSchema = z.string().regex(/^\d{2}:\d{2}$/, 'Enter a time.');

const CustomRangeSchema = z
  .object({
    days: z.object({ from: z.date().optional(), to: z.date().optional() }).optional(),
    from_time: TimeSchema,
    to_time: TimeSchema,
  })
  .transform((draft, ctx): TimeRange => {
    const first_day = draft.days?.from;
    if (first_day === undefined) {
      ctx.addIssue({ code: 'custom', path: ['days'], message: 'Pick a day.' });
      return z.NEVER;
    }
    const now = Date.now();
    const from = atTime(first_day, draft.from_time);
    // The To minute is inclusive, so 23:59 reaches the end of the day.
    const to = new Date(
      Math.min(atTime(draft.days?.to ?? first_day, draft.to_time).getTime() + MINUTE_MS - 1, now)
    );
    if (from >= to) {
      ctx.addIssue({
        code: 'custom',
        path: ['to_time'],
        message: from.getTime() > now ? 'From is later than now.' : 'To must be after From.',
      });
      return z.NEVER;
    }
    return { from: from.toISOString(), to: to.toISOString() };
  });

type CustomRangeDraft = z.input<typeof CustomRangeSchema>;

const draftOf = (value: TimeRange | null): CustomRangeDraft => {
  if (value === null) return { days: undefined, from_time: '00:00', to_time: '23:59' };
  const from = new Date(value.from);
  const to = new Date(value.to);
  return { days: { from, to }, from_time: timeOf(from), to_time: timeOf(to) };
};

function CustomRangePicker({
  value,
  onApply,
}: {
  readonly value: TimeRange | null;
  readonly onApply: (range: TimeRange) => void;
}) {
  const form = useForm<CustomRangeDraft, unknown, TimeRange>({
    resolver: zodResolver(CustomRangeSchema),
    defaultValues: draftOf(value),
    mode: 'onChange',
  });
  const { errors, isValid } = form.formState;
  const error_message = errors.from_time?.message ?? errors.to_time?.message;

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) form.reset(draftOf(value));
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn('h-9 gap-1.5 text-xs', value && 'text-primary')}
          data-testid="time-range-custom"
        >
          <CalendarIcon className="size-3.5" strokeWidth={2.1} aria-hidden />
          {value ? rangeLabel(value) : 'Custom'}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="Choose a time range" className="w-auto p-0">
        <form noValidate onSubmit={form.handleSubmit(onApply)}>
          <Controller
            control={form.control}
            name="days"
            rules={{ deps: ['to_time'] }}
            render={({ field }) => (
              <Calendar
                mode="range"
                className="mx-auto"
                autoFocus
                selected={
                  field.value?.from ? { from: field.value.from, to: field.value.to } : undefined
                }
                defaultMonth={field.value?.from}
                disabled={{ after: new Date() }}
                onSelect={(next) => {
                  field.onChange(next);
                  const last = next?.to ?? next?.from;
                  if (last && isToday(last)) {
                    form.setValue('to_time', timeOf(new Date()), { shouldValidate: true });
                  }
                }}
              />
            )}
          />
          <div className="flex items-end gap-2 border-t p-3">
            <label className="flex flex-col gap-1 text-xs">
              From
              <Input
                type="time"
                {...form.register('from_time', { deps: ['to_time'] })}
                aria-invalid={errors.from_time ? true : undefined}
                aria-describedby="time-range-error"
                className="h-8 text-xs"
                data-testid="time-range-from-time"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              To
              <Input
                type="time"
                {...form.register('to_time')}
                aria-invalid={errors.to_time ? true : undefined}
                aria-describedby="time-range-error"
                className="h-8 text-xs"
                data-testid="time-range-to-time"
              />
            </label>
            <PopoverClose asChild>
              <Button
                type="submit"
                size="sm"
                className="h-8"
                disabled={!isValid}
                data-testid="time-range-apply"
              >
                Apply
              </Button>
            </PopoverClose>
          </div>
          <p
            id="time-range-error"
            role="alert"
            className="text-destructive px-3 pb-3 text-xs empty:hidden"
            data-testid="time-range-custom-error"
          >
            {error_message}
          </p>
        </form>
      </PopoverContent>
    </Popover>
  );
}
