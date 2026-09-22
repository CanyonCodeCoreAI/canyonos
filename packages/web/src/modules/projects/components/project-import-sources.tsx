import { Badge } from '@repo/ui/shadcn/badge';
import { Button } from '@repo/ui/shadcn/button';
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/shadcn/toggle-group';

/**
 * Where a project can come from. Only `upload` is wired to the API; the rest render their pitch with
 * a disabled call to action rather than a button that fails silently.
 */
export const IMPORT_SOURCES = [
  { value: 'upload', label: 'Upload source' },
  { value: 'git', label: 'Connect a Git repo' },
  { value: 'template', label: 'From a template' },
  { value: 'empty', label: 'Empty project' },
] as const;

export type ImportSource = (typeof IMPORT_SOURCES)[number]['value'];

const PLANNED_SOURCES: Record<
  Exclude<ImportSource, 'upload'>,
  { readonly title: string; readonly body: string; readonly cta: string }
> = {
  git: {
    title: 'Connect a Git repository',
    body: "Authorize GitHub or GitLab and we'll import the default branch, then keep the project in sync on every push.",
    cta: 'Connect GitHub',
  },
  template: {
    title: 'Start from a template',
    body: 'Pick a reference project — support triage, research agent, RAG pipeline — and adapt it in place.',
    cta: 'Browse templates',
  },
  empty: {
    title: 'Start an empty project',
    body: 'Create the project shell now and add workflows, agents, and tools as you build them.',
    cta: 'Create empty project',
  },
};

export function ImportSourceTabs({
  value,
  onChange,
}: {
  readonly value: ImportSource;
  readonly onChange: (source: ImportSource) => void;
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next as ImportSource);
      }}
      aria-label="Project source"
      data-testid="project-import-sources"
      className="border-border bg-secondary w-fit gap-1 rounded-[0.5625rem] border p-[0.1875rem]"
    >
      {IMPORT_SOURCES.map((source) => (
        <ToggleGroupItem
          key={source.value}
          value={source.value}
          data-testid={`project-import-source-${source.value}`}
          className="text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-foreground h-auto rounded-[0.4375rem] px-[0.8125rem] py-1.5 text-[0.78125rem] font-semibold hover:bg-transparent data-[state=on]:shadow-sm"
        >
          {source.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export function PlannedSourcePanel({
  source,
}: {
  readonly source: Exclude<ImportSource, 'upload'>;
}) {
  const planned = PLANNED_SOURCES[source];

  return (
    <div
      className="border-border bg-card flex flex-col items-start gap-4 rounded-2xl border p-8 shadow-xs"
      data-testid={`project-import-planned-${source}`}
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-foreground text-[0.9375rem] font-semibold">{planned.title}</span>
          <Badge variant="outline" data-testid={`project-import-planned-badge-${source}`}>
            Coming soon
          </Badge>
        </div>
        <p className="text-muted-foreground max-w-[52ch] text-[0.8125rem] leading-relaxed">
          {planned.body}
        </p>
      </div>
      <Button size="sm" disabled>
        {planned.cta}
      </Button>
      <p className="text-muted-foreground text-xs">
        Not available yet. Upload a source folder or .zip to create a project today.
      </p>
    </div>
  );
}
