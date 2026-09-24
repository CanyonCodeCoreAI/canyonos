import { getRouteApi } from '@tanstack/react-router';

import { EmptyState } from '@/modules/core/components/EmptyState';
import { CpuScreen } from '@/modules/resources/screens/cpu.screen';

const route = getRouteApi('/_authenticated/resources/$resource');

export function ResourceScreen() {
  const { resource } = route.useParams();

  switch (resource) {
    case 'cpu':
      return <CpuScreen />;
    default:
      return <EmptyState>No analytics available for this resource yet.</EmptyState>;
  }
}
