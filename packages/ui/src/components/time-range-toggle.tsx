//

import { cn } from '../lib/utils';
import { ToggleGroup, ToggleGroupItem } from '../shadcn/toggle-group';

interface TimeRangeOption {
  readonly value: string;
  readonly label: string;
}

const DEFAULT_OPTIONS = [
  { value: '24h', label: 'Last 24h' },
  { value: '7d', label: 'Last 7d' },
  { value: '30d', label: 'Last 30d' },
] as const satisfies readonly TimeRangeOption[];

type DefaultTimeRange = (typeof DEFAULT_OPTIONS)[number]['value'];

interface TimeRangeToggleProps {
  value: string;
  onValueChange: (value: string) => void;
  options?: readonly TimeRangeOption[];
  className?: string;
  'aria-label'?: string;
  'data-testid'?: string;
}

function TimeRangeToggle({
  value,
  onValueChange,
  options = DEFAULT_OPTIONS,
  className,
  'aria-label': ariaLabel = 'Time range',
  'data-testid': dataTestId,
}: TimeRangeToggleProps) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next) onValueChange(next);
      }}
      aria-label={ariaLabel}
      data-testid={dataTestId}
      className={cn(
        'border-border bg-secondary gap-1 rounded-[0.5625rem] border p-[0.1875rem]',
        className
      )}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          className="text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-foreground h-auto rounded-[0.4375rem] px-[0.8125rem] py-1.5 text-[0.78125rem] font-semibold hover:bg-transparent data-[state=on]:shadow-sm"
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export { DEFAULT_OPTIONS, TimeRangeToggle };
export type { DefaultTimeRange, TimeRangeOption, TimeRangeToggleProps };
