import type { ResourceId } from '@cc-forge/api/resources';

export interface ResourceItem {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  // The route segment and the API's resource id diverge for memory (`/resources/memory` vs `mem`),
  // so usage lookups key off this instead of the route id.
  readonly usage_id: ResourceId;
}

export const PALETTE = {
  emerald: '#2f9e5e',
  steel: '#4a93b8',
  amber: '#c79a3e',
  clay: '#c27a55',
  rust: '#c2683f',
  violet: '#8a7fb5',
  teal: '#5aa39a',
} as const;

export const resources: readonly ResourceItem[] = [
  { id: 'gpu', name: 'GPU', color: PALETTE.emerald, usage_id: 'gpu' },
  { id: 'cpu', name: 'CPU', color: PALETTE.steel, usage_id: 'cpu' },
  { id: 'memory', name: 'Memory', color: PALETTE.amber, usage_id: 'mem' },
  { id: 'storage', name: 'Storage', color: PALETTE.rust, usage_id: 'storage' },
  { id: 'tokens', name: 'Tokens', color: PALETTE.violet, usage_id: 'tokens' },
];
