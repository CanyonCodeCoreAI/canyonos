// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { ToggleGroup, ToggleGroupItem } from '../shadcn/toggle-group';

interface TimeRangeOption<T extends string = string> {
  readonly value: T;
  readonly label: string;
}

const DEFAULT_OPTIONS = [
  { value: '24h', label: 'Last 24h' },
  { value: '7d', label: 'Last 7d' },
  { value: '30d', label: 'Last 30d' },
] as const satisfies readonly TimeRangeOption[];

type DefaultTimeRange = (typeof DEFAULT_OPTIONS)[number]['value'];

interface TimeRangeToggleProps<T extends string = string> {
  value: T;
  onValueChange: (value: T) => void;
  /** Called when the option already selected is clicked again. */
  onReselect?: () => void;
  options: readonly TimeRangeOption<T>[];
  className?: string;
  'aria-label'?: string;
  'data-testid'?: string;
}

function TimeRangeToggle<T extends string = string>({
  value,
  onValueChange,
  onReselect,
  options,
  className,
  'aria-label': ariaLabel = 'Time range',
  'data-testid': dataTestId,
}: TimeRangeToggleProps<T>) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(next) => {
        if (!next) {
          onReselect?.();
          return;
        }
        const picked = options.find((option) => option.value === next);
        if (picked) onValueChange(picked.value);
      }}
      aria-label={ariaLabel}
      data-testid={dataTestId}
      className={className}
    >
      {options.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value}>
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export { DEFAULT_OPTIONS, TimeRangeToggle };
export type { DefaultTimeRange, TimeRangeOption, TimeRangeToggleProps };
