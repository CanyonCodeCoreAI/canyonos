import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { DeployPerformanceScreen } from '@/modules/deploy/screens/deploy-performance.screen';
import { ProjectDeployPerformanceBreadcrumbs } from '@/modules/projects/components/project-breadcrumbs';

// The policy the emulation runs, carried in the URL by the screen that set it. Every part is
// optional: arriving here without one is normal for a project that deployed long ago, and the screen
// starts from a stated default instead.
const PerformanceSearchSchema = z.object({
  load: z.coerce.number().int().positive().optional(),
  unit: z.enum(['second', 'minute', 'hour', 'day']).optional(),
  priority: z.coerce.number().min(0).max(100).optional(),
  endpoint: z.enum(['bedrock', 'gemini', 'custom_internal']).optional(),
});

function DeployPerformanceRoute() {
  const { project_id } = Route.useParams();
  return <DeployPerformanceScreen project_id={project_id} />;
}

export const Route = createFileRoute('/_authenticated/projects/$project_id/deploy/performance')({
  validateSearch: PerformanceSearchSchema,
  staticData: {
    breadcrumbSlot: ProjectDeployPerformanceBreadcrumbs,
  },
  component: DeployPerformanceRoute,
});
