import { useQuery } from '@tanstack/react-query';

import type { ResourceOverview } from '@canyonos/api/resources';

import { EntityPill } from '@repo/ui/components/entity-pill';
import { apiCall, forgeApi } from '@/api';
import { EmptyState } from '@/modules/core/components/EmptyState';
import { CPUAllocationCard } from '@/modules/resources/components/cpu/CPUAllocationCard';
import { CPUCostCard } from '@/modules/resources/components/cpu/CPUCostCard';
import { CPUIdleCard } from '@/modules/resources/components/cpu/CPUIdleCard';
import { TopRequestsCard } from '@/modules/resources/components/TopRequestsCard';
import { TopWorkflowsCard } from '@/modules/resources/components/TopWorkflowsCard';
import {
  buildAllocation,
  buildCostChart,
  buildIdleChart,
  buildTopRequests,
  buildTopWorkflows,
} from '@/modules/resources/resources.selectors';

export function CpuScreen() {
  const { data: overview } = useQuery({
    queryKey: ['resources', 'cpu'],
    queryFn: () => apiCall<ResourceOverview>(() => forgeApi.resources.cpu.get()),
  });

  if (!overview) return <EmptyState>Could not load CPU information</EmptyState>;

  const { focus: resource } = overview;

  const cost = buildCostChart(resource);
  const idle = buildIdleChart(overview.projects);
  const allocation = buildAllocation(resource, overview.projects);
  const topWorkflows = buildTopWorkflows(resource, overview.projects);
  const topRequests = buildTopRequests(overview);

  return (
    <main
      className="flex min-h-0 flex-1 flex-col gap-5 px-7 pt-6 pb-12"
      data-testid="cpu-analytics"
    >
      <div className="flex flex-col gap-2.5">
        <EntityPill
          segments={[{ label: 'Resource', emphasis: 'strong' }, { label: resource.label }]}
        />
        <p className="text-muted-foreground text-sm">{resource.description}</p>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[1.45fr_1fr]">
        <div className="flex min-w-0 flex-col gap-4">
          <CPUCostCard title={`${resource.label} cost over time`} model={cost} />
          <CPUIdleCard title={`${resource.label} idle time per workflow`} model={idle} />
          <TopRequestsCard title="Top requests" usageHeader={resource.label} rows={topRequests} />
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <CPUAllocationCard model={allocation} />
          <TopWorkflowsCard
            title={`Top workflows by ${resource.label} usage`}
            items={topWorkflows}
          />
        </div>
      </div>
    </main>
  );
}
