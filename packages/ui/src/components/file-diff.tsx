import { cn } from '../lib/utils';

export type FileDiffChange = 'added' | 'removed' | 'modified';
export type FileDiffRowKind = 'unchanged' | 'added' | 'removed' | 'changed';

// Structurally assignable from the API's `DiffRow`, so the dashboard can hand SDK rows straight in.
// Kept local so this presentational component never imports the API contract.
export interface FileDiffRow {
  readonly kind: FileDiffRowKind;
  readonly old_line: number | null;
  readonly new_line: number | null;
  readonly old_text: string | null;
  readonly new_text: string | null;
}

export interface FileDiffProps {
  readonly path: string;
  readonly change: FileDiffChange;
  readonly rows: readonly FileDiffRow[];
  readonly className?: string;
}

const CHANGE_BADGE: Record<FileDiffChange, { label: string; className: string }> = {
  added: { label: 'Added', className: 'bg-accent text-accent-foreground' },
  removed: { label: 'Removed', className: 'bg-destructive/12 text-destructive' },
  modified: { label: 'Modified', className: 'bg-chart-3/15 text-chart-3' },
};

const LINE_CELL = 'w-px select-none px-3 text-right align-top text-muted-foreground tabular-nums';
const CONTENT_CELL = 'px-3 align-top whitespace-pre';

function oldTone(kind: FileDiffRowKind, present: boolean): string {
  if (!present) return 'bg-muted/30';
  if (kind === 'removed' || kind === 'changed') return 'bg-destructive/10';
  return '';
}

function newTone(kind: FileDiffRowKind, present: boolean): string {
  if (!present) return 'bg-muted/30';
  if (kind === 'added' || kind === 'changed') return 'bg-accent/50';
  return '';
}

function oldSign(kind: FileDiffRowKind, present: boolean): string {
  return present && (kind === 'removed' || kind === 'changed') ? '-' : ' ';
}

function newSign(kind: FileDiffRowKind, present: boolean): string {
  return present && (kind === 'added' || kind === 'changed') ? '+' : ' ';
}

function DiffContent({ sign, text }: { readonly sign: string; readonly text: string | null }) {
  return (
    <>
      <span className="text-muted-foreground mr-2 inline-block w-2 select-none" aria-hidden>
        {sign}
      </span>
      <span>{text ?? ''}</span>
    </>
  );
}

export function FileDiff({ path, change, rows, className }: FileDiffProps) {
  const badge = CHANGE_BADGE[change];
  return (
    <section
      className={cn('bg-card flex flex-col overflow-hidden rounded-xl border', className)}
      aria-label={`Diff for ${path}`}
    >
      <header className="bg-muted/40 flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2.5">
        <span className="text-foreground truncate font-mono text-xs">{path}</span>
        <span
          className={cn(
            'shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold',
            badge.className
          )}
        >
          {badge.label}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse font-mono text-xs leading-relaxed">
          <caption className="sr-only">{`Side-by-side diff for ${path}`}</caption>
          <thead>
            <tr className="text-muted-foreground text-[0.7rem] tracking-wide uppercase">
              <th aria-hidden className={LINE_CELL} />
              <th scope="col" className="px-3 py-1.5 text-left font-medium">
                Before
              </th>
              <th aria-hidden className={LINE_CELL} />
              <th scope="col" className="px-3 py-1.5 text-left font-medium">
                After
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const has_old = row.old_text !== null;
              const has_new = row.new_text !== null;
              return (
                <tr key={`${row.old_line ?? 'x'}:${row.new_line ?? 'x'}:${index}`}>
                  <td aria-hidden className={cn(LINE_CELL, oldTone(row.kind, has_old))}>
                    {row.old_line ?? ''}
                  </td>
                  <td className={cn(CONTENT_CELL, oldTone(row.kind, has_old))}>
                    <DiffContent sign={oldSign(row.kind, has_old)} text={row.old_text} />
                  </td>
                  <td aria-hidden className={cn(LINE_CELL, newTone(row.kind, has_new))}>
                    {row.new_line ?? ''}
                  </td>
                  <td className={cn(CONTENT_CELL, newTone(row.kind, has_new))}>
                    <DiffContent sign={newSign(row.kind, has_new)} text={row.new_text} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
