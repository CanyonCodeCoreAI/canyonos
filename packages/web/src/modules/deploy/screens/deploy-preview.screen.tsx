import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronLeftIcon, ChevronRightIcon, CloudUploadIcon } from 'lucide-react';
import { useState } from 'react';

import type { DeployPreview } from '@cc-forge/api/deploy';

import { FileDiff } from '@repo/ui/components/file-diff';
import { Badge } from '@repo/ui/shadcn/badge';
import { Button } from '@repo/ui/shadcn/button';
import { EmptyState } from '@/modules/core/components/EmptyState';
import { QueryError } from '@/modules/core/components/QueryError';
import { DeploySkeleton } from '@/modules/deploy/components/deploy-skeleton';
import { deployErrorFor } from '@/modules/deploy/deploy.errors';
import { useTriggerDeploy } from '@/modules/deploy/deploy.mutations';
import { projectDeployPreviewQueryOptions } from '@/modules/deploy/deploy.queries';
import { formatDateTime } from '@/modules/projects/projects.format';

export function DeployPreviewScreen({ project_id }: { readonly project_id: string }) {
  const preview_query = useQuery(projectDeployPreviewQueryOptions(project_id));

  if (preview_query.isPending) {
    return <DeploySkeleton />;
  }

  if (preview_query.error || !preview_query.data) {
    return (
      <QueryError
        message="Could not load the deploy preview."
        onRetry={() => void preview_query.refetch()}
        className="m-7"
        test_id="deploy-preview-error"
      />
    );
  }

  return <DeployPreviewContent project_id={project_id} preview={preview_query.data} />;
}

function DeployPreviewContent({
  project_id,
  preview,
}: {
  readonly project_id: string;
  readonly preview: DeployPreview;
}) {
  const deployMutation = useTriggerDeploy(project_id);

  return (
    <main
      className="mx-auto flex min-h-0 w-full max-w-[90.625rem] flex-1 flex-col gap-5 px-7 pt-6 pb-6"
      data-testid="deploy-preview-screen"
    >
      <header className="flex shrink-0 flex-col gap-2">
        <h1 className="text-foreground text-[1.75rem] leading-tight font-bold tracking-tight">
          Review changes
        </h1>
        <BaseNote preview={preview} />
        <SummaryPills summary={preview.summary} />
      </header>

      <PreviewBody files={preview.files} has_changes={preview.has_changes} />

      <DeployPreviewError isError={deployMutation.isError} error={deployMutation.error} />

      <footer className="flex shrink-0 items-center justify-end gap-3">
        <Button asChild variant="outline" data-testid="deploy-preview-cancel">
          <Link to="/projects/$project_id/deploy" params={{ project_id }}>
            Cancel
          </Link>
        </Button>
        <Button
          type="button"
          data-testid="deploy-preview-confirm"
          disabled={deployMutation.isPending}
          onClick={() => deployMutation.mutate()}
        >
          <CloudUploadIcon aria-hidden />
          Confirm &amp; deploy
        </Button>
      </footer>
    </main>
  );
}

function BaseNote({ preview }: { readonly preview: DeployPreview }) {
  if (preview.base_deployment_id === null) {
    return (
      <p className="text-muted-foreground text-sm">
        This is the first deployment for this project. Every file is new.
      </p>
    );
  }
  return (
    <p className="text-muted-foreground text-sm">
      Changes since the last successful deployment on {formatDateTime(preview.base_created_at)}.
    </p>
  );
}

function SummaryPills({ summary }: { readonly summary: DeployPreview['summary'] }) {
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="deploy-preview-summary">
      <Badge variant="success">{summary.added} added</Badge>
      <Badge variant="destructive">{summary.removed} removed</Badge>
      <Badge className="bg-chart-3/15 text-chart-3 border-transparent">
        {summary.modified} modified
      </Badge>
    </div>
  );
}

function PreviewBody({
  files,
  has_changes,
}: {
  readonly files: DeployPreview['files'];
  readonly has_changes: boolean;
}) {
  if (!has_changes) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <EmptyState size="section" test_id="deploy-preview-empty">
          Nothing has changed since the last successful deployment. You can re-deploy the current
          files as they are.
        </EmptyState>
      </div>
    );
  }
  return <FileDiffPager files={files} />;
}

// One file diff at a time with prev/next and a position counter, so a large changeset stays
// reviewable without an endless scroll (GitHub's file pager behaviour).
function FileDiffPager({ files }: { readonly files: DeployPreview['files'] }) {
  const [index, setIndex] = useState(0);
  const file = files[index]!;
  const total = files.length;

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3" data-testid="deploy-preview-pager">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="deploy-preview-prev"
          aria-label="Previous file"
          disabled={index === 0}
          onClick={() => setIndex((current) => Math.max(0, current - 1))}
        >
          <ChevronLeftIcon aria-hidden />
          Previous
        </Button>

        <p
          className="text-muted-foreground min-w-0 text-center text-sm"
          data-testid="deploy-preview-counter"
          aria-live="polite"
        >
          <span className="text-foreground font-medium">
            File {index + 1} of {total}
          </span>
          <span className="text-muted-foreground block truncate font-mono text-xs">
            {file.path}
          </span>
        </p>

        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="deploy-preview-next"
          aria-label="Next file"
          disabled={index === total - 1}
          onClick={() => setIndex((current) => Math.min(total - 1, current + 1))}
        >
          Next
          <ChevronRightIcon aria-hidden />
        </Button>
      </div>

      <div className="min-h-0 flex-1" data-testid={`deploy-preview-file-${file.path}`}>
        <FileDiff path={file.path} change={file.change} rows={file.rows} className="h-full" />
      </div>
    </section>
  );
}

function DeployPreviewError({
  isError,
  error,
}: {
  readonly isError: boolean;
  readonly error: unknown;
}) {
  if (!isError) return null;
  return (
    <p className="text-destructive text-sm" role="alert" data-testid="deploy-preview-submit-error">
      {deployErrorFor(error)}
    </p>
  );
}
