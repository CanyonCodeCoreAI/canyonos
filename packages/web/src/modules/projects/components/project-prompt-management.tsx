import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDownIcon } from 'lucide-react';
import { useState } from 'react';

import type { PromptEdit, PromptItem, PromptsResponse } from '@canyonos/api/prompts';

import { Button } from '@repo/ui/shadcn/button';
import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { toast } from '@repo/ui/shadcn/sonner';
import { Textarea } from '@repo/ui/shadcn/textarea';
import { apiCall, forgeAuthApi } from '@/api';
import { EmptyState } from '@/modules/core/components/EmptyState';
import { QueryError } from '@/modules/core/components/QueryError';
import { ProjectMetricsSection } from '@/modules/projects/components/project-metrics-section';
import { projectQueryKeys } from '@/modules/projects/projects.query-cache';

/** Splits a `<agent>.<function>` prompt name; a name without a dot is all agent. */
function nameParts(name: string) {
  const dot = name.indexOf('.');
  if (dot === -1) return { agent: name, function: null };
  return { agent: name.slice(0, dot), function: name.slice(dot + 1) };
}

/** The `<hash>-<n>` tail of a saved version; anything else keeps the raw string as the version. */
function versionParts(version: string) {
  const parts = version.split('-');
  const [hash, revision] = parts.slice(-2);
  if (parts.length < 3 || !hash || !revision || !/^\d+$/.test(revision)) {
    return { hash: null, revision: version };
  }
  return { hash, revision };
}

export function ProjectPromptManagement({ project_id }: { readonly project_id: string }) {
  const query = useQuery({
    queryKey: projectQueryKeys.prompts(project_id),
    queryFn: () => apiCall<PromptsResponse>(() => forgeAuthApi.projects[project_id]!.prompts.get()),
    retry: false,
  });

  return (
    <ProjectMetricsSection
      title="Prompt management"
      description="Prompts from the project's config/prompts.yaml. Edits apply to the running project until the next reload."
      test_id="project-prompt-management"
      framed
    >
      {query.error ? (
        <QueryError
          message="Could not load prompts."
          onRetry={() => void query.refetch()}
          test_id="project-prompt-error"
        />
      ) : query.isPending ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : query.data.items.length === 0 ? (
        <EmptyState size="section" test_id="project-prompt-empty">
          No prompts. Add config/prompts.yaml to your project.
        </EmptyState>
      ) : (
        <div className="border-border/70 overflow-hidden rounded-xl border">
          {query.data.items.map((item) => (
            <PromptRow key={item.name} project_id={project_id} item={item} />
          ))}
        </div>
      )}
    </ProjectMetricsSection>
  );
}

function PromptRow({
  project_id,
  item,
}: {
  readonly project_id: string;
  readonly item: PromptItem;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PromptEdit | null>(null);
  const query_client = useQueryClient();
  const name = nameParts(item.name);
  const version = versionParts(item.version);
  const header: [string, string][] = [
    ['Agent', name.agent],
    ['Function', name.function ?? '—'],
    ['Date', item.updated_at ? new Date(item.updated_at).toLocaleDateString() : '—'],
    ['Version', version.revision],
    ['Hash', version.hash ?? '—'],
  ];
  const save = useMutation({
    mutationFn: (edit: PromptEdit) =>
      apiCall<PromptItem>(() => forgeAuthApi.projects[project_id]!.prompts[item.name]!.put(edit)),
    onSuccess: (saved) => {
      toast.success(`Saved ${saved.name} as ${saved.version}`, { testId: 'app-toast' });
      setDraft(null);
      return query_client.invalidateQueries({ queryKey: projectQueryKeys.prompts(project_id) });
    },
    onError: () => toast.error(`Could not save ${item.name}`, { testId: 'app-toast' }),
  });

  return (
    <div className="border-border/50 border-b last:border-b-0">
      <button
        type="button"
        className="hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.03] grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 text-left focus-visible:outline-none"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-label={item.name}
      >
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          {header.map(([label, value], index) => (
            <span key={label} className="flex items-center gap-2 whitespace-nowrap">
              {index > 0 ? <span className="text-border">|</span> : null}
              <span className="text-muted-foreground">{label}:</span>
              <span className="text-foreground font-mono">{value}</span>
            </span>
          ))}
        </span>
        <ChevronDownIcon
          className={`text-muted-foreground size-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>
      {open ? (
        <div className="border-border/50 bg-foreground/[0.02] space-y-3 border-t px-4 py-3">
          {draft ? (
            <>
              <PromptField
                label="System"
                value={draft.system}
                onChange={(system) => setDraft({ ...draft, system })}
              />
              <PromptField
                label="User"
                value={draft.user}
                onChange={(user) => setDraft({ ...draft, user })}
              />
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={save.isPending || !draft.system.trim() || !draft.user.trim()}
                  onClick={() => save.mutate(draft)}
                  data-testid="prompt-save"
                >
                  Save
                </Button>
              </div>
            </>
          ) : (
            <>
              <PromptPart label="System" text={item.system} />
              <PromptPart label="User" text={item.user} />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setDraft({ system: item.system, user: item.user })}
                  data-testid="prompt-edit"
                >
                  Edit
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function PromptField({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-muted-foreground mb-1 block text-xs font-medium">{label}</span>
      <Textarea
        className="min-h-32 font-mono text-xs"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function PromptPart({ label, text }: { readonly label: string; readonly text: string }) {
  return (
    <div>
      <p className="text-muted-foreground mb-1 text-xs font-medium">{label}</p>
      <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap">{text}</pre>
    </div>
  );
}
