export type FlowAnchor = 'top' | 'bottom' | 'left' | 'right';
export type FlowNodeKind = 'workflow' | 'agent' | 'tool';

export type FlowNodeChip = { kind: 'components' | 'tools' | 'routes'; label: string };

export type FlowNodeData = {
  kind: FlowNodeKind;
  file: string;
  role: string;
  tag: string | null;
  chips: readonly FlowNodeChip[];
};

export interface FlowNodeSpec {
  id: string;
  position: { x: number; y: number };
  data: FlowNodeData;
}

export type FlowEdgeData = {
  edge_type: 'route' | 'call' | 'loop' | 'return';
  label: string | null;
};

export interface FlowEdgeSpec {
  id: string;
  source: string;
  target: string;
  source_anchor: FlowAnchor;
  target_anchor: FlowAnchor;
  data: FlowEdgeData;
}
