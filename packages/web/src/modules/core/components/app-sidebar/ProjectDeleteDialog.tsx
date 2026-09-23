import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@repo/ui/shadcn/alert-dialog';
import { Button } from '@repo/ui/shadcn/button';
import { apiCall, forgeAuthApi } from '@/api';
import { refreshAfterProjectDelete } from '@/modules/projects/projects.query-cache';

export interface ProjectDeleteTarget {
  readonly id: string;
  readonly name: string;
  // Whether the user is currently viewing this project; drives navigating away after deletion.
  readonly is_active: boolean;
}

interface ProjectDeleteDialogProps {
  readonly target: ProjectDeleteTarget | null;
  readonly onClose: () => void;
}

// Rendered once at the sidebar section level, not inside a project row, so it stays mounted while the
// deleted row unmounts. That ordering lets Radix restore the body pointer-events lock on close; if the
// dialog lived in the row it would be torn down mid-open and leave the whole page unclickable.
export function ProjectDeleteDialog({ target, onClose }: ProjectDeleteDialogProps) {
  const navigate = useNavigate();
  const query_client = useQueryClient();

  const delete_mutation = useMutation({
    mutationFn: (item: ProjectDeleteTarget) =>
      apiCall<void>(() => forgeAuthApi.projects[item.id]!.delete()),
    onSuccess: async (_data, item) => {
      // Close first so the dialog unmounts cleanly, then drop the project from the caches.
      onClose();
      await refreshAfterProjectDelete(query_client, item.id);
      if (item.is_active) await navigate({ to: '/' });
    },
  });

  const error_message =
    delete_mutation.error instanceof Error
      ? delete_mutation.error.message
      : 'Could not delete the project. Please try again.';

  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(next) => {
        if (next || delete_mutation.isPending) return;
        delete_mutation.reset();
        onClose();
      }}
    >
      <AlertDialogContent data-testid="project-delete-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete project</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes{' '}
            <span className="text-foreground font-medium">{target?.name}</span> and everything in it
            — all files and workflows. This can&rsquo;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {delete_mutation.isError ? (
          <p className="text-destructive text-sm" role="alert" data-testid="project-delete-error">
            {error_message}
          </p>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button variant="outline" size="sm" data-testid="project-delete-cancel">
              Cancel
            </Button>
          </AlertDialogCancel>
          <Button
            variant="destructive"
            size="sm"
            data-testid="project-delete-confirm"
            disabled={delete_mutation.isPending}
            onClick={() => target && delete_mutation.mutate(target)}
          >
            {delete_mutation.isPending ? 'Deleting…' : 'Delete project'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
