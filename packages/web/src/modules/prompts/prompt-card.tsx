// I would separate this file, but it's a NIT, iterate on this component complexity as we better define this

import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { ChevronDownIcon, PencilIcon } from 'lucide-react';
import { useForm } from 'react-hook-form';
import type { KeyboardEvent, ReactNode } from 'react';

import {
  next_revision,
  prompt_name_parts,
  SystemPromptCreateSchema,
  version_parts,
} from '@canyonos/api/prompts';
import type {
  Prompt,
  PromptListItem,
  SystemPrompt,
  SystemPromptCreate,
} from '@canyonos/api/prompts';

import { Badge } from '@repo/ui/shadcn/badge';
import { Button } from '@repo/ui/shadcn/button';
import { cardVariants } from '@repo/ui/shadcn/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@repo/ui/shadcn/collapsible';
import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { toast } from '@repo/ui/shadcn/sonner';
import { Textarea } from '@repo/ui/shadcn/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@repo/ui/shadcn/tooltip';
import { cn } from '@repo/ui/utils';
import { QueryError } from '@/modules/core/components/QueryError';
import { formatDay } from '@/modules/projects/projects.format';
import {
  promptErrorMessage,
  promptQueryOptions,
  useCreateSystemPrompt,
  useMakePromptLive,
} from '@/modules/prompts/prompts.queries';

const TOAST = { testId: 'app-toast' } as const;
const GROW =
  'data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden';

function versionDate(version: SystemPrompt): string | null {
  if (!version.updated_at) return null;
  const date = new Date(version.updated_at);
  return Number.isNaN(date.getTime()) ? null : formatDay(date);
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '') ?? '';
}

export function PromptCard({
  project_id,
  summary,
}: {
  readonly project_id: string;
  readonly summary: PromptListItem;
}) {
  const live = version_parts(summary.live.version).label;
  return (
    <Collapsible asChild>
      <section
        className={cardVariants({ className: 'group/card' })}
        aria-label={summary.name}
        data-testid="prompt-card"
        data-name={summary.name}
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="hover:bg-foreground/[0.025] flex w-full items-center gap-4 rounded-lg px-5 py-4 text-left transition-colors group-data-[state=open]/card:rounded-b-none focus-visible:outline-none"
            data-testid="prompt-toggle"
          >
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <PromptName name={summary.name} />
              <span
                className="text-muted-foreground truncate text-xs group-data-[state=open]/card:hidden"
                data-testid="prompt-preview"
              >
                {firstLine(summary.live.content)}
              </span>
            </span>
            <span
              className="text-primary flex shrink-0 items-center gap-1.5 font-mono text-xs font-semibold"
              data-testid="prompt-live"
            >
              <span className="bg-primary size-1.5 rounded-full" aria-hidden />
              {live} live
            </span>
            <ChevronDownIcon
              className="text-muted-foreground ease-snappy size-4 shrink-0 transition-transform duration-150 group-data-[state=open]/card:rotate-180"
              aria-hidden
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className={GROW}>
          <PromptHistory project_id={project_id} name={summary.name} />
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

function PromptName({ name }: { readonly name: string }) {
  const parts = prompt_name_parts(name);
  if (parts.function === null) {
    return <span className="text-foreground font-mono text-sm font-semibold">{parts.agent}</span>;
  }
  return (
    <span className="truncate font-mono text-sm">
      <span className="text-muted-foreground">{parts.agent}.</span>
      <span className="text-foreground font-semibold">{parts.function}</span>
    </span>
  );
}

/** Mounts when the card opens, so the history is read on demand and dropped on close. */
function PromptHistory({
  project_id,
  name,
}: {
  readonly project_id: string;
  readonly name: string;
}) {
  const query = useQuery(promptQueryOptions(project_id, name));
  if (query.isError && !query.isFetching) {
    return (
      <div className="border-border/60 border-t p-5">
        <QueryError
          message={promptErrorMessage(query.error, 'Could not load its versions.')}
          onRetry={() => void query.refetch()}
          test_id="prompt-body-error"
          retry_test_id="prompt-body-retry"
        />
      </div>
    );
  }
  if (!query.data) {
    return (
      <div
        className="border-border/60 border-t p-5"
        aria-busy="true"
        data-testid="prompt-body-loading"
      >
        <Skeleton className="h-28 w-full rounded-md" />
      </div>
    );
  }
  const prompt = query.data;
  return (
    <div className="border-border/60 flex flex-col gap-5 border-t p-5" data-testid="prompt-body">
      {/* Keyed on the newest version: a save brings a new one, which closes and resets the editor. */}
      <LivePanel key={prompt.versions[0]?.version} project_id={project_id} prompt={prompt} />
      <VersionList project_id={project_id} prompt={prompt} />
    </div>
  );
}

function VersionHeading({
  prompt,
  version,
  children,
}: {
  readonly prompt: Prompt;
  readonly version: SystemPrompt;
  readonly children?: ReactNode;
}) {
  const parts = version_parts(version.version);
  const date = versionDate(version);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="text-foreground font-mono text-sm font-bold">{parts.label}</span>
        {version.version === prompt.live.version ? (
          <Badge variant="success">Live</Badge>
        ) : (
          <Badge variant="outline">Not live</Badge>
        )}
        <span className={cn('text-muted-foreground text-xs', date === null && 'hidden')}>
          {date}
        </span>
        <span
          className={cn(
            'text-muted-foreground/70 font-mono text-[0.6875rem]',
            parts.hash === null && 'hidden'
          )}
          title={`Content hash ${parts.hash}`}
        >
          {parts.hash}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function PromptText({ text, test_id }: { readonly text: string; readonly test_id: string }) {
  return (
    <pre
      className="bg-muted/60 border-border/50 text-foreground overflow-x-auto rounded-md border px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap"
      data-testid={test_id}
    >
      {text}
    </pre>
  );
}

function MutationError({
  error,
  test_id,
}: {
  readonly error: Error | null;
  readonly test_id: string;
}) {
  return (
    <p
      className={cn('text-destructive text-xs', error === null && 'hidden')}
      role="alert"
      data-testid={test_id}
    >
      {error?.message}
    </p>
  );
}

/** What agents get now, with the editor that saves the text as the next version. */
function LivePanel({
  project_id,
  prompt,
}: {
  readonly project_id: string;
  readonly prompt: Prompt;
}) {
  const create = useCreateSystemPrompt(project_id, prompt.name);
  const next = `v${next_revision(prompt)}`;
  const live = version_parts(prompt.live.version).label;
  const form = useForm<SystemPromptCreate>({
    resolver: zodResolver(SystemPromptCreateSchema),
    defaultValues: { content: prompt.live.content },
    mode: 'onChange',
  });
  const blank = form.watch('content').trim() === '';
  const submit = form.handleSubmit((body) =>
    create.mutate(body, {
      onSuccess: (created) => {
        const label = version_parts(created.version).label;
        toast.success(`Saved ${label} of ${prompt.name}. Agents still get ${live}.`, TOAST);
      },
    })
  );
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <Collapsible className="group/editor flex flex-col gap-3" data-testid="prompt-live-panel">
      <VersionHeading prompt={prompt} version={prompt.live}>
        <Tooltip>
          <TooltipTrigger asChild>
            <CollapsibleTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="text-muted-foreground hover:text-foreground size-8 group-data-[state=open]/editor:hidden"
                aria-label="Edit prompt"
                data-testid="prompt-edit"
              >
                <PencilIcon aria-hidden />
              </Button>
            </CollapsibleTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">Edit prompt</TooltipContent>
        </Tooltip>
      </VersionHeading>
      <p
        className="text-muted-foreground text-xs group-data-[state=open]/editor:hidden"
        data-testid="prompt-hint"
      >
        Agents get this version on every call.
      </p>
      <div className="group-data-[state=open]/editor:hidden">
        <PromptText text={prompt.live.content} test_id="prompt-text" />
      </div>
      <CollapsibleContent className={GROW}>
        <form className="flex flex-col gap-3" onSubmit={submit} data-testid="prompt-editor">
          <p className="text-muted-foreground text-xs" data-testid="prompt-editor-hint">
            Saving adds {next}. Agents keep getting {live} until you make {next} live.
          </p>
          <MutationError error={create.error} test_id="prompt-save-error" />
          <Textarea
            {...form.register('content')}
            className="border-input focus-visible:border-input min-h-48 font-mono text-xs leading-relaxed shadow-none focus-visible:ring-0"
            aria-label="System prompt"
            disabled={create.isPending}
            autoFocus
            onKeyDown={onKeyDown}
          />
          <div className="flex justify-end gap-2">
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-xs"
                disabled={create.isPending}
              >
                Cancel
              </Button>
            </CollapsibleTrigger>
            <Button
              type="submit"
              size="sm"
              className="text-xs"
              disabled={blank || create.isPending}
              data-testid="prompt-save"
            >
              {create.isPending ? 'Saving…' : `Save as ${next}`}
            </Button>
          </div>
        </form>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Every stored version, newest first; the live one is marked from the data, the others can go live. */
function VersionList({
  project_id,
  prompt,
}: {
  readonly project_id: string;
  readonly prompt: Prompt;
}) {
  return (
    <nav aria-label={`Versions of ${prompt.name}`} className="flex flex-col gap-1.5">
      <p className="text-muted-foreground text-[0.6875rem] font-semibold tracking-wide uppercase">
        Versions
      </p>
      <ol className="flex flex-col gap-1">
        {prompt.versions.map((version) => (
          <VersionRow
            key={version.version}
            project_id={project_id}
            prompt={prompt}
            version={version}
          />
        ))}
      </ol>
    </nav>
  );
}

function VersionRow({
  project_id,
  prompt,
  version,
}: {
  readonly project_id: string;
  readonly prompt: Prompt;
  readonly version: SystemPrompt;
}) {
  const make_live = useMakePromptLive(project_id, prompt.name);
  const is_live = version.version === prompt.live.version;
  const parts = version_parts(version.version);
  const date = versionDate(version);
  const label = parts.label;
  const live = version_parts(prompt.live.version).label;

  return (
    <Collapsible asChild>
      <li
        className="group/row border-border/60 data-[active=true]:border-primary/40 data-[active=true]:bg-primary/[0.04] rounded-md border"
        data-testid="prompt-version"
        data-version={version.version}
        data-active={is_live}
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="hover:bg-foreground/[0.03] flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-xs transition-colors focus-visible:outline-none"
          >
            <span
              className={cn(
                'size-2 shrink-0 rounded-full border',
                is_live ? 'bg-primary border-primary' : 'border-muted-foreground/60 bg-card'
              )}
              aria-hidden
            />
            <span className="font-mono font-semibold">{label}</span>
            <span
              className={cn(
                'text-primary text-[0.625rem] font-bold tracking-wide uppercase',
                !is_live && 'hidden'
              )}
            >
              live
            </span>
            <span
              className={cn(
                'text-muted-foreground ml-auto text-[0.6875rem] tabular-nums',
                date === null && 'hidden'
              )}
            >
              {date}
            </span>
            <ChevronDownIcon
              className="text-muted-foreground ease-snappy size-3.5 shrink-0 transition-transform duration-150 group-data-[state=open]/row:rotate-180"
              aria-hidden
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className={GROW}>
          <div className="flex flex-col gap-3 px-3 pt-1 pb-3">
            <PromptText text={version.content} test_id="prompt-version-text" />
            <MutationError error={make_live.error} test_id="prompt-live-error" />
            <div className={cn('flex items-center justify-between gap-3', is_live && 'hidden')}>
              <p className="text-muted-foreground text-xs">
                Agents get {live}. Make {label} live to switch them.
              </p>
              <Button
                size="sm"
                className="text-xs"
                disabled={make_live.isPending}
                data-testid="prompt-make-live"
                onClick={() =>
                  make_live.mutate(version.version, {
                    onSuccess: () =>
                      toast.success(
                        `${label} of ${prompt.name} is live. Running agents switch within 10 seconds.`,
                        TOAST
                      ),
                  })
                }
              >
                {make_live.isPending ? 'Making live…' : `Make ${label} live`}
              </Button>
            </div>
          </div>
        </CollapsibleContent>
      </li>
    </Collapsible>
  );
}
