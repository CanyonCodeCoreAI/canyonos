import { postgres_store } from './postgres';
import type { MonitoringStore } from './store';

export const monitoring_store: MonitoringStore = postgres_store;

export type {
  ErrorSummaryRow,
  LogsFilter,
  MonitoringStore,
  ResourceEntryRow,
  ResourceSeriesRow,
  ResourceUtilizationRow,
  SeriesRow,
} from './store';
