import { cn } from '@repo/ui/utils';
import type { ProjectChipModel } from '@/modules/resources/overview.selectors';

interface ProjectChipRowProps {
  chips: readonly ProjectChipModel[];
  onSelect: (id: string | null) => void;
}

export function ProjectChipRow({ chips, onSelect }: ProjectChipRowProps) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => (
        <button
          key={chip.id ?? 'all'}
          type="button"
          aria-pressed={chip.selected}
          data-selected={chip.selected}
          onClick={() => onSelect(chip.id)}
          data-testid={chip.id == null ? 'overview-chip-all' : `overview-chip-${chip.id}`}
          className={cn(
            'ease-snappy focus-visible:ring-ring inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-[color,background-color,border-color,box-shadow,transform] duration-150 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none active:scale-[0.97]',
            'data-[selected=false]:border-border data-[selected=false]:bg-card data-[selected=false]:text-secondary-foreground data-[selected=false]:hover:bg-accent/60',
            'data-[selected=true]:border-foreground data-[selected=true]:bg-foreground data-[selected=true]:text-background'
          )}
          style={
            chip.selected && chip.color
              ? {
                  borderColor: chip.color,
                  backgroundColor: `color-mix(in srgb, ${chip.color} 12%, transparent)`,
                  color: 'var(--foreground)',
                }
              : undefined
          }
        >
          {chip.color ? (
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: chip.color }}
              aria-hidden
            />
          ) : null}
          {chip.label}
        </button>
      ))}
    </div>
  );
}
