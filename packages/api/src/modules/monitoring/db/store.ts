import type { MetricsWindow } from '../../metrics/metrics.types';
import type { MonitoringResource } from '../monitoring.signals';
import type {
  MonitoringLlmCall,
  MonitoringLog,
  MonitoringLogSource,
  MonitoringTrace,
} from '../monitoring.types';

export type ResourceSeriesRow = {
  resource: MonitoringResource;
  average: number;
  peak: number;
  latest: number;
  samples: number;
  values: (number | null)[];
};

export type ResourceEntryRow = {
  key: string;
  series: ResourceSeriesRow[];
};

export type ResourceUtilizationRow = {
  bucket_seconds: number;
  bucket_start_ats: string[];
  machines: ResourceEntryRow[];
  agents: ResourceEntryRow[];
};

export type ErrorSummaryRow = {
  total: number;
  by_type: { key: string; count: number }[];
  by_agent: { key: string; count: number }[];
};

export type SeriesRow = {
  bucket_seconds: number;
  bucket_start_ats: string[];
  traffic: (number | null)[];
  errors: (number | null)[];
  latency: (number | null)[];
  saturation: (number | null)[];
};

export type LogsFilter = {
  limit: number;
  errors_only: boolean;
  agent?: string;
  replica?: string;
};

export interface MonitoringStore {
  series(project_id: string, time_window: MetricsWindow): Promise<SeriesRow>;
  logs(
    project_id: string,
    time_window: MetricsWindow,
    filter: LogsFilter
  ): Promise<MonitoringLog[]>;
  log_sources(project_id: string, time_window: MetricsWindow): Promise<MonitoringLogSource[]>;
  llm_calls(
    project_id: string,
    time_window: MetricsWindow,
    limit: number
  ): Promise<MonitoringLlmCall[]>;
  traces(project_id: string, time_window: MetricsWindow, limit: number): Promise<MonitoringTrace[]>;
  resource_utilization(
    project_id: string,
    time_window: MetricsWindow
  ): Promise<ResourceUtilizationRow>;
  error_summary(project_id: string, time_window: MetricsWindow): Promise<ErrorSummaryRow>;
}
