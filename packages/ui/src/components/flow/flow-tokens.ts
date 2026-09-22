import type { FlowEdgeData, FlowNodeChip, FlowNodeKind } from './types';

type EdgeType = FlowEdgeData['edge_type'];
type ChipKind = FlowNodeChip['kind'];

export const nodeColorToken: Readonly<Record<FlowNodeKind, string>> = {
  workflow: 'var(--flow-workflow)',
  agent: 'var(--flow-agent)',
  tool: 'var(--flow-tool)',
};

// One width for every design card, so a row reads as a row and a node sitting under its caller
// lines up on x alone — the graph layout places top-left corners and knows nothing about widths.
// Height is intentionally left to the content.
export const nodeWidthToken = '14rem';

export const chipColorToken: Readonly<Record<ChipKind, string>> = {
  components: 'var(--flow-workflow)',
  tools: 'var(--flow-tool)',
  routes: 'var(--flow-agent)',
};

export const edgeColorToken: Readonly<Record<EdgeType, string>> = {
  route: 'var(--flow-edge-route)',
  call: 'var(--flow-edge-call)',
  loop: 'var(--flow-edge-loop)',
  return: 'var(--flow-edge-return)',
};

export const edgeDashArray: Readonly<Record<EdgeType, string | undefined>> = {
  route: undefined,
  call: '4 4',
  loop: '6 4',
  return: '6 4',
};

export const edgeStrokeWidth: Readonly<Record<EdgeType, number>> = {
  route: 1.8,
  call: 1.5,
  loop: 1.8,
  return: 1.8,
};
