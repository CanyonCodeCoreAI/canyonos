import { MoreHorizontalIcon, Trash2Icon } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui/shadcn/dropdown-menu';
import { isCanyonOsLocalMode } from '@/modules/core/canyonos/local-mode';

interface ProjectActionsMenuProps {
  readonly project_id: string;
  readonly project_name: string;
  // Selecting "Delete project" only asks the stable parent to open its confirmation dialog. The
  // dialog is intentionally NOT rendered here: this row unmounts when the project is deleted, and a
  // Radix dialog unmounted while open never restores the body pointer-events lock.
  readonly onRequestDelete: () => void;
}

export function ProjectActionsMenu({
  project_id,
  project_name,
  onRequestDelete,
}: ProjectActionsMenuProps) {
  // Delete is the only action here, and a local install's projects come from the machine rather
  // than from the dashboard — removing one there would not remove it from the box.
  if (isCanyonOsLocalMode) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${project_name} actions`}
          data-testid={`nav-project-actions-${project_id}`}
          className="app-sidebar-hide-when-collapsed text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground flex size-5 shrink-0 items-center justify-center rounded-md transition-colors"
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontalIcon className="size-3.5" strokeWidth={2.2} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          variant="destructive"
          data-testid={`nav-project-delete-${project_id}`}
          onSelect={() => {
            // Let the menu close normally. If we preventDefault to keep it open, this modal dropdown
            // is still mounted-open when the row unmounts on deletion, and Radix never restores the
            // body pointer-events lock — freezing the page until a refresh. Deferring the request to
            // the next tick lets the menu's focus trap release before the dialog claims focus.
            requestAnimationFrame(() => onRequestDelete());
          }}
        >
          <Trash2Icon aria-hidden />
          Delete project
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
