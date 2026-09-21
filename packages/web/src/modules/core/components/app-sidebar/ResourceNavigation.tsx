import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import type { CSSProperties } from 'react';

import type { FleetOverview } from '@canyonos/api/resources';

import { ResourceIcon } from '@repo/ui/components/resource-icon';
import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { cn } from '@repo/ui/utils';
import { apiCall, forgeAuthApi } from '@/api';
import { SectionLabel } from '@/modules/core/components/app-sidebar/SectionLabel';
import { resources } from '@/modules/core/navigation/navigation';
import { buildResourceUsageLabels } from '@/modules/resources/overview.selectors';
import type { ResourceItem } from '@/modules/core/navigation/navigation';

function ResourceRow({
  item,
  is_active,
  is_loading,
  usage,
}: {
  readonly item: ResourceItem;
  readonly is_active: boolean;
  readonly is_loading: boolean;
  readonly usage: string | undefined;
}) {
  return (
    <Link
      to="/resources/$resource"
      params={{ resource: item.id }}
      data-testid={`nav-${item.id}`}
      title={item.name}
      className={cn(
        'app-sidebar-row app-sidebar-collapse-to-icon gap-2.5 px-2.75 py-2.25',
        is_active && 'app-sidebar-active'
      )}
      style={{ '--app-sidebar-color': item.color } as CSSProperties}
    >
      <ResourceIcon
        resource={item.id}
        className="text-sidebar-foreground size-3.75 shrink-0"
        strokeWidth={2}
      />
      <span
        className={cn(
          'app-sidebar-hide-when-collapsed text-foreground min-w-0 flex-1 truncate text-[0.84375rem] font-semibold',
          is_active && 'font-bold'
        )}
      >
        {item.name}
      </span>
      {is_loading ? (
        <Skeleton
          className="app-sidebar-hide-when-collapsed h-2.5 w-11 shrink-0 rounded-sm"
          data-testid={`nav-${item.id}-usage-loading`}
        />
      ) : usage ? (
        <span
          className="app-sidebar-meta app-sidebar-hide-when-collapsed"
          data-testid={`nav-${item.id}-usage`}
        >
          {usage}
        </span>
      ) : null}
    </Link>
  );
}

export function ResourceNavigation() {
  const params = useParams({ strict: false });
  const overview_query = useQuery({
    queryKey: ['resources', 'overview', '30d'],
    queryFn: () =>
      apiCall<FleetOverview>(() =>
        forgeAuthApi.resources.overview.get({ $query: { time_window: '30d' } })
      ),
    retry: false,
  });
  // Usage is decoration on a navigation row, so an unavailable fleet overview drops the number
  // rather than showing an error the sidebar has no room to explain.
  const usage_labels = overview_query.data
    ? buildResourceUsageLabels(overview_query.data)
    : undefined;

  return (
    <section aria-label="Resources" className="app-sidebar-section">
      <SectionLabel>Resources</SectionLabel>
      {resources.map((item) => (
        <ResourceRow
          key={item.id}
          item={item}
          is_active={params.resource === item.id}
          is_loading={overview_query.isPending}
          usage={usage_labels?.get(item.usage_id)}
        />
      ))}
    </section>
  );
}
