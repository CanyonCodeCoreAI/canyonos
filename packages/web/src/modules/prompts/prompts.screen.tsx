import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';

import type { PromptListItem } from '@canyonos/api/prompts';

import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { TooltipProvider } from '@repo/ui/shadcn/tooltip';
import { EmptyState } from '@/modules/core/components/EmptyState';
import { QueryError } from '@/modules/core/components/QueryError';
import { PromptCard } from '@/modules/prompts/prompt-card';
import { promptErrorMessage, promptsQueryOptions } from '@/modules/prompts/prompts.queries';

export function PromptsScreen({ project_id }: { readonly project_id: string }) {
  const query = useQuery(promptsQueryOptions(project_id));

  return (
    <main
      className="scroll-area flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto p-7"
      data-testid="project-prompts-screen"
      data-state={screenState(query)}
      data-project-id={project_id}
    >
      <header className="flex flex-col gap-1.5">
        <h1 className="text-foreground text-[1.5rem] leading-none font-bold tracking-tight">
          Prompts
        </h1>
        <p className="text-muted-foreground max-w-[42rem] text-[0.8125rem] leading-relaxed text-pretty">
          The system prompt each agent function is sent, with every saved version. Make a version
          live and running agents switch to it within seconds, no redeploy.
        </p>
      </header>
      <PromptsBody project_id={project_id} query={query} />
    </main>
  );
}

type PromptsQuery = UseQueryResult<PromptListItem[]>;

// A retry after an error is a fresh load, not the old error.
function screenState(query: PromptsQuery): 'loading' | 'error' | 'empty' | 'list' {
  if (query.isError && !query.isFetching) return 'error';
  if (!query.data) return 'loading';
  return query.data.length === 0 ? 'empty' : 'list';
}

function PromptsBody({
  project_id,
  query,
}: {
  readonly project_id: string;
  readonly query: PromptsQuery;
}) {
  switch (screenState(query)) {
    case 'loading':
      return (
        <div className="flex flex-col gap-4" aria-busy="true" data-testid="project-prompt-loading">
          <Skeleton className="h-[4.25rem] w-full rounded-[1.125rem]" />
          <Skeleton className="h-[4.25rem] w-full rounded-[1.125rem]" />
        </div>
      );
    case 'error':
      return (
        <QueryError
          message={promptErrorMessage(query.error, 'Could not load prompts.')}
          onRetry={() => void query.refetch()}
          test_id="project-prompt-error"
          retry_test_id="project-prompt-retry"
        />
      );
    case 'empty':
      return (
        <EmptyState test_id="project-prompt-empty">
          No prompts yet. Add config/prompts.yaml to the project and deploy it again.
        </EmptyState>
      );
    case 'list':
      return (
        <TooltipProvider delayDuration={150}>
          <div className="flex flex-col gap-4" data-testid="prompt-list">
            {query.data?.map((prompt) => (
              <PromptCard key={prompt.name} project_id={project_id} summary={prompt} />
            ))}
          </div>
        </TooltipProvider>
      );
  }
}
