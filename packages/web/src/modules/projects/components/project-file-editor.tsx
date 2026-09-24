import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDebouncedCallback } from 'use-debounce';

import type { FileContent } from '@canyonos/api/projects';

import { CodeEditor } from '@repo/ui/components/editor';
import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { cn } from '@repo/ui/utils';
import { apiCall, forgeAuthApi } from '@/api';
import { QueryError } from '@/modules/core/components/QueryError';
import {
  projectQueryKeys,
  refreshProjectAfterFileSave,
} from '@/modules/projects/projects.query-cache';

const SAVE_DEBOUNCE_MS = 800;

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const STATUS_LABEL: Record<SaveStatus, string> = {
  idle: 'Up to date',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Save failed — will retry on next edit',
};

interface ProjectFileEditorProps {
  readonly project_id: string;
  readonly file_id: string;
  readonly className?: string;
}

export function ProjectFileEditor({ project_id, file_id, className }: ProjectFileEditorProps) {
  const file_query = useQuery({
    queryKey: projectQueryKeys.file(project_id, file_id),
    queryFn: () =>
      apiCall<FileContent>(() => forgeAuthApi.projects[project_id]!.files[file_id]!.get()),
    retry: false,
  });

  if (file_query.isPending) {
    return <FileEditorSkeleton className={className} />;
  }

  if (file_query.error || !file_query.data) {
    return (
      <section
        className={cn(
          'border-border bg-card flex min-h-[28rem] min-w-0 flex-1 items-center rounded-2xl border p-4 shadow-sm',
          className
        )}
        data-testid="project-file-error"
      >
        <QueryError
          message="Could not load this source file."
          onRetry={() => void file_query.refetch()}
          className="w-full"
        />
      </section>
    );
  }

  return (
    <FileEditor
      key={file_query.data.id}
      project_id={project_id}
      file={file_query.data}
      className={className}
    />
  );
}

function FileEditor({
  project_id,
  file,
  className,
}: {
  readonly project_id: string;
  readonly file: FileContent;
  readonly className?: string;
}) {
  const query_client = useQueryClient();
  const [value, setValue] = useState(file.content);
  const [status, setStatus] = useState<SaveStatus>('idle');

  // Only touch React state while mounted. `flushOnExit` runs the pending save during unmount (file
  // switch remounts via `key`); the write must still land, but its status updates must not.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const save = useDebouncedCallback(
    async (next: string) => {
      if (mounted.current) setStatus('saving');
      try {
        const updated = await apiCall<FileContent>(() =>
          forgeAuthApi.projects[project_id]!.files[file.id]!.patch({ content: next })
        );
        await refreshProjectAfterFileSave(query_client, project_id, updated);
        if (mounted.current) setStatus('saved');
      } catch {
        // Retry happens on the next edit, which schedules a fresh save through this same callback —
        // no detached promise, no post-unmount timer.
        if (mounted.current) setStatus('error');
      }
    },
    SAVE_DEBOUNCE_MS,
    { flushOnExit: true }
  );

  const handleChange = useCallback(
    (next: string) => {
      setValue(next);
      void save(next);
    },
    [save]
  );

  return (
    <section
      className={cn(
        'border-border bg-card flex min-h-[28rem] min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border shadow-sm',
        className
      )}
      data-testid="project-file"
      aria-label={`Editing ${file.path}`}
    >
      <header className="border-border/60 bg-card/70 flex min-h-[2.75rem] flex-wrap items-center justify-between gap-3 border-b px-4 py-2.5 backdrop-blur-sm">
        <h1 className="text-foreground truncate font-mono text-sm font-semibold tracking-tight">
          {file.path}
        </h1>
        <span
          className={cn(
            'text-xs font-semibold',
            status === 'error' ? 'text-destructive' : 'text-muted-foreground'
          )}
          data-testid="project-file-save-status"
          data-status={status}
          role="status"
          aria-live="polite"
        >
          {STATUS_LABEL[status]}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden" data-testid="project-file-editor">
        <CodeEditor
          value={value}
          onChange={handleChange}
          language={file.language === 'python' ? 'python' : 'text'}
          ariaLabel={`${file.path} source editor`}
        />
      </div>
    </section>
  );
}

const CODE_SKELETON_LINES: readonly { id: string; indent: number; width: string }[] = [
  { id: 'a', indent: 0, width: '62%' },
  { id: 'b', indent: 0, width: '44%' },
  { id: 'c', indent: 0, width: '0' },
  { id: 'd', indent: 0, width: '52%' },
  { id: 'e', indent: 1, width: '70%' },
  { id: 'f', indent: 2, width: '48%' },
  { id: 'g', indent: 1, width: '58%' },
  { id: 'h', indent: 0, width: '0' },
  { id: 'i', indent: 0, width: '50%' },
  { id: 'j', indent: 1, width: '74%' },
  { id: 'k', indent: 2, width: '56%' },
  { id: 'l', indent: 1, width: '40%' },
];

export function FileEditorSkeleton({ className }: { readonly className?: string }) {
  return (
    <section
      className={cn(
        'border-border bg-card flex min-h-[28rem] min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border shadow-sm',
        className
      )}
      data-testid="project-file-loading"
      aria-busy="true"
      aria-label="Loading source"
    >
      <header className="border-border/60 bg-card/70 flex min-h-[2.75rem] items-center justify-between gap-3 border-b px-4 py-2.5 backdrop-blur-sm">
        <Skeleton className="h-4 w-32 rounded" />
        <Skeleton className="h-3 w-14 rounded" />
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4" aria-hidden>
        {CODE_SKELETON_LINES.map((line) => (
          <div key={line.id} className="flex items-center gap-4">
            <Skeleton className="h-3 w-4 shrink-0 rounded opacity-50" />
            {line.width === '0' ? (
              <span className="h-3" aria-hidden />
            ) : (
              <Skeleton
                className="h-3 rounded"
                style={{ width: line.width, marginLeft: `${line.indent * 1.25}rem` }}
              />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
