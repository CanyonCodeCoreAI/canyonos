import { SparklesIcon } from 'lucide-react';

import { cn } from '@repo/ui/utils';

/**
 * The offer to analyse one agent or query.
 *
 * Disabled on purpose, and said out loud by the caller's preview note: the analysis behind it does
 * not exist yet, and a control that looks live and does nothing is worse than one that says what it
 * is. Shaped as a pill rather than a full button so a row can carry it without turning into a
 * toolbar.
 *
 * Sits above the row's own click overlay (`z-[2]`), which is what keeps it from being swallowed by
 * the target that opens the drawer.
 */
export function AnalyzeButton({
  subject,
  describedBy,
  test_id,
  className,
}: {
  /** What is being analysed, so the label reads as a sentence to a screen reader. */
  readonly subject: string;
  /** The caller's preview note, so the reason it is inert is read with it. */
  readonly describedBy: string;
  readonly test_id: string;
  readonly className?: string;
}) {
  return (
    <button
      type="button"
      disabled
      aria-describedby={describedBy}
      aria-label={`Analyze ${subject}`}
      data-testid={test_id}
      className={cn(
        // Brand green, tinted rather than solid: several rows carry one at once, and solid green
        // buttons would outrank the figures they sit beside.
        'border-primary/35 bg-accent text-primary relative z-[2] inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.6875rem] font-semibold whitespace-nowrap disabled:cursor-default',
        className
      )}
    >
      <SparklesIcon className="size-3 shrink-0" strokeWidth={2} aria-hidden />
      Analyze
    </button>
  );
}

/** The note every pill points at. One per view, so the reason is stated once. */
export function AnalyzePreviewNote({
  id,
  className,
}: {
  readonly id: string;
  readonly className?: string;
}) {
  return (
    <p id={id} className={cn('text-muted-foreground px-3 text-[0.71875rem]', className)}>
      Analysis is not available yet — those controls are a preview.
    </p>
  );
}
