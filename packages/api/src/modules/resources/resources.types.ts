import { z } from 'zod';

import { MetricsWindowSchema } from '../metrics/metrics.types';
import type { RequestStatus } from '../core/types';

export type { RequestStatus };

export const ResourceIdSchema = z.enum(['gpu', 'cpu', 'mem', 'storage', 'tokens']);
export type ResourceId = z.infer<typeof ResourceIdSchema>;

export type DeltaDirection = 'increase' | 'decrease';

export interface Delta {
  readonly value: number;
  readonly direction: DeltaDirection;
}

export interface ResourceProject {
  readonly id: string;
  readonly name: string;
  readonly usage: number;
  readonly allocation: number;
  readonly utilization_pct: number;
  readonly idle_minutes: number;
  readonly cost_share: number;
}

export interface ResourceRequest {
  readonly id: string;
  readonly project_id: string;
  readonly project_name: string;
  readonly usage: number;
  readonly run_time_ms: number;
  readonly latency_ms: number;
  readonly status: RequestStatus;
  readonly time_label: string;
}

export interface ResourceHeader {
  readonly id: ResourceId;
  readonly label: string;
  readonly description: string;
  readonly usage_unit: string;
  readonly allocation_unit: string;
  readonly spend: number;
  readonly spend_delta: Delta;
  readonly cost_series: readonly number[];
}

export interface ResourceOverview {
  readonly focus: ResourceHeader;
  readonly projects: readonly ResourceProject[];
  readonly requests: readonly ResourceRequest[];
}

// value/sub_label are preformatted display strings — the client renders them verbatim.
export const FleetKpiSchema = z.object({
  id: z.string(),
  label: z.string(),
  value: z.string(),
  sub_label: z.string(),
  tone: z.enum(['neutral', 'positive']),
});

// available is false for resources with no data source yet (compute): empty pool, zero usage. Only
// tokens carries real per-execution data.
export const FleetResourceSchema = z.object({
  id: ResourceIdSchema,
  label: z.string(),
  unit: z.string(),
  pool: z.number(),
  available: z.boolean(),
});

export const FleetProjectResourceUsageSchema = z.object({
  resource_id: ResourceIdSchema,
  usage: z.number(),
});

export const FleetProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  color_index: z.number().int(),
  cost: z.number(),
  requests: z.number().int().nonnegative(),
  // A per-block average — named honestly, since the runtime gives no true p95.
  avg_latency_ms: z.number().nonnegative(),
  error_rate_pct: z.number().nonnegative(),
  resource_usage: z.array(FleetProjectResourceUsageSchema),
});

export const FleetOverviewSchema = z.object({
  kpis: z.array(FleetKpiSchema),
  resources: z.array(FleetResourceSchema),
  projects: z.array(FleetProjectSchema),
  time_window: MetricsWindowSchema,
});

export type FleetKpi = z.infer<typeof FleetKpiSchema>;
export type FleetResource = z.infer<typeof FleetResourceSchema>;
export type FleetProjectResourceUsage = z.infer<typeof FleetProjectResourceUsageSchema>;
export type FleetProject = z.infer<typeof FleetProjectSchema>;
export type FleetOverview = z.infer<typeof FleetOverviewSchema>;
