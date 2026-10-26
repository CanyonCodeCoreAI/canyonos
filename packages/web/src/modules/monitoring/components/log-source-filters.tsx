// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { useQuery } from '@tanstack/react-query';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@repo/ui/shadcn/select';
import { logSourcesQueryOptions } from '@/modules/monitoring/monitoring.queries';
import type { RangeSelection } from '@/modules/core/time-range';

export const ALL_SOURCES = 'all';

const TRIGGER_CLASS = 'h-9 w-44 text-xs';

interface LogSourceFiltersProps {
  readonly project_id: string;
  readonly range: RangeSelection;
  readonly agent: string;
  readonly replica: string;
  readonly onAgentChange: (agent: string) => void;
  readonly onReplicaChange: (replica: string) => void;
}

export function LogSourceFilters({
  project_id,
  range,
  agent,
  replica,
  onAgentChange,
  onReplicaChange,
}: LogSourceFiltersProps) {
  const query = useQuery(logSourcesQueryOptions(project_id, { range }));

  const sources = query.data?.sources ?? [];
  const replicas =
    agent === ALL_SOURCES
      ? [...new Set(sources.flatMap((source) => source.replicas))].sort()
      : (sources.find((source) => source.agent === agent)?.replicas ?? []);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={agent}
        onValueChange={(next) => {
          onAgentChange(next);
          onReplicaChange(ALL_SOURCES);
        }}
      >
        <SelectTrigger
          className={TRIGGER_CLASS}
          aria-label="Filter logs by agent"
          data-testid="logs-agent-filter"
        >
          <SelectValue placeholder="All agents" />
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value={ALL_SOURCES}>All agents</SelectItem>
          {sources.map((source) => (
            <SelectItem key={source.agent} value={source.agent}>
              {source.agent}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={replica} onValueChange={onReplicaChange} disabled={replicas.length === 0}>
        <SelectTrigger
          className={TRIGGER_CLASS}
          aria-label="Filter logs by replica"
          data-testid="logs-replica-filter"
        >
          <SelectValue placeholder="All replicas" />
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value={ALL_SOURCES}>All replicas</SelectItem>
          {replicas.map((name) => (
            <SelectItem key={name} value={name}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
