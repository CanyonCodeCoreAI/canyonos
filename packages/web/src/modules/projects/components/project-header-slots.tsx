import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { RefreshCwIcon } from 'lucide-react';

import { Button } from '@repo/ui/shadcn/button';
import { cn } from '@repo/ui/utils';
import { refreshProjectDashboard } from '@/modules/projects/projects.query-cache';

const route = getRouteApi('/_authenticated/projects/$project_id');

export function ProjectHeaderSlot() {
  const { project_id } = route.useParams();
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
