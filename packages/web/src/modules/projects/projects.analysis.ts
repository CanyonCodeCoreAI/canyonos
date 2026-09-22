import type { MetricsBlock } from '@canyonos/api/metrics';

import { parseMoney } from './projects.format';

const ANALYZED_AGENTS = 3;

export function analyzableAgents(rows: readonly MetricsBlock[]): ReadonlySet<string> {
  const ranked = rows
    .filter((block) => parseMoney(block.cost) > 0)
    .toSorted((left, right) => parseMoney(right.cost) - parseMoney(left.cost))
    .slice(0, ANALYZED_AGENTS);

  return new Set(ranked.map((block) => block.agent_id));
}
