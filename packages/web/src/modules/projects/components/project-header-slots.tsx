import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { PlusIcon, RefreshCwIcon } from 'lucide-react';

import { Button } from '@repo/ui/shadcn/button';
import { cn } from '@repo/ui/utils';
import { isCanyonOsLocalMode } from '@/modules/core/canyonos/local-mode';
import { ProjectDeployControls } from '@/modules/deploy/components/deploy-controls';
import { refreshProjectDashboard } from '@/modules/projects/projects.query-cache';

const route = getRouteApi('/_authenticated/projects/$project_id');

export function ProjectHeaderSlot() {
  const { project_id } = route.useParams();

  // Local mode has no deploy target, so re-reading what is on screen is the only header action it
  // can honestly offer.
  if (isCanyonOsLocalMode) return <RefreshProjectButton project_id={project_id} />;

  return (
    <>
      <RefreshProjectButton project_id={project_id} />
      <ProjectDeployControls project_id={project_id} />
    </>
  );
}

function RefreshProjectButton({ project_id }: { readonly project_id: string }) {
  const query_client = useQueryClient();
  const refresh = useMutation({
    mutationFn: () => refreshProjectDashboard(query_client, project_id),
  });

  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => refresh.mutate()}
      disabled={refresh.isPending}
      className="px-2.5 xl:px-3"
      title="Refresh project overview"
      aria-label="Refresh project overview"
      data-testid="project-header-refresh"
    >
      <RefreshCwIcon
        className={cn(refresh.isPending && 'animate-spin motion-reduce:animate-none')}
        strokeWidth={2.1}
        aria-hidden
      />
      <span className="hidden xl:inline">Refresh</span>
    </Button>
  );
}

export function CreateProjectHeaderSlot() {
  return (
    <Button asChild size="sm">
      <Link to="/projects/import" data-testid="header-create-project">
        <PlusIcon aria-hidden />
        Create project
      </Link>
    </Button>
  );
}
