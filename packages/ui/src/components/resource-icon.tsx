import { BrainCogIcon, CircuitBoardIcon, CpuIcon, DatabaseIcon, MicrochipIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ComponentProps } from 'react';

const RESOURCE_ICONS: Record<string, LucideIcon> = {
  gpu: CircuitBoardIcon,
  cpu: CpuIcon,
  mem: MicrochipIcon,
  memory: MicrochipIcon,
  storage: DatabaseIcon,
  tokens: BrainCogIcon,
};

interface ResourceIconProps extends ComponentProps<LucideIcon> {
  resource: string;
}

export function ResourceIcon({ resource, ...props }: ResourceIconProps) {
  const Icon = RESOURCE_ICONS[resource];
  return Icon ? <Icon {...props} /> : null;
}
