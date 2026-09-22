import { SectionLabel as SectionLabelText } from '@repo/ui/components/section-label';

interface SectionLabelProps {
  children: string;
  count?: number;
}

export function SectionLabel({ children, count }: SectionLabelProps) {
  return (
    <div className="app-sidebar-hide-when-collapsed flex items-center justify-between gap-2 px-2.5 pt-1.75 pb-1.5">
      <SectionLabelText>{children}</SectionLabelText>
      {count !== undefined ? (
        <span className="text-muted-foreground font-mono text-[0.6875rem] font-semibold">
          {count}
        </span>
      ) : null}
    </div>
  );
}
