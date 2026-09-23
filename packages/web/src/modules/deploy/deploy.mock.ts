import { CpuIcon, DatabaseIcon, GlobeIcon, ServerIcon, SlidersHorizontalIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// The deploy-complete screen sources its real data from the machine — project and setup name, the
// provider, and the live address. The provisioned-resource breakdown below is the one piece the
// deployment record does not yet carry, so it stays illustrative until the API reports what it created.

export interface DeployResourceSummary {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly icon: LucideIcon;
  readonly accent: string;
  readonly detail: string;
}

export const PROVISIONED_RESOURCES: readonly DeployResourceSummary[] = [
  {
    id: 'compute',
    title: 'Compute',
    subtitle: 'EC2 instance',
    icon: ServerIcon,
    accent: 'var(--flow-agent)',
    detail: 'm6i.xlarge · i-0123456789abcdef0 · us-west-2a',
  },
  {
    id: 'network',
    title: 'Network',
    subtitle: 'VPC & access',
    icon: GlobeIcon,
    accent: 'var(--chart-1)',
    detail: 'subnet-0123456789abcdef0 · 2 SGs · EIP 203.0.113.10',
  },
  {
    id: 'database',
    title: 'Database',
    subtitle: 'state store',
    icon: DatabaseIcon,
    accent: 'var(--chart-3)',
    detail: 'Aurora PostgreSQL · 500 GB · 14 tables',
  },
  {
    id: 'llm',
    title: 'LLM model',
    subtitle: 'provider',
    icon: CpuIcon,
    accent: 'var(--chart-5)',
    detail: 'Anthropic Claude Opus 4.8 · 400k tok/min',
  },
  {
    id: 'harness',
    title: 'Harness',
    subtitle: 'agent runtime',
    icon: SlidersHorizontalIcon,
    accent: 'var(--chart-4)',
    detail: 'LangGraph · 4 agents · 7 tools · concurrency 16',
  },
];
