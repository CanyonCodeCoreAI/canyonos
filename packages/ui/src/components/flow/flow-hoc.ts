import type { Edge, EdgeTypes, Node, NodeTypes } from '@xyflow/react';

import { FlowEdge } from './flow-edge';
import { FlowNodeCard } from './flow-node';
import type { FlowEdgeData, FlowEdgeSpec, FlowNodeData, FlowNodeSpec } from './types';

export type FlowNode = Node<FlowNodeData, FlowNodeData['kind']>;
export type FlowEdgeModel = Edge<FlowEdgeData, 'flow'>;

export const flowNodeTypes: NodeTypes = {
  workflow: FlowNodeCard,
  agent: FlowNodeCard,
  tool: FlowNodeCard,
};

export const flowEdgeTypes: EdgeTypes = { flow: FlowEdge };

export function toFlow(input: {
  readonly nodes: readonly FlowNodeSpec[];
  readonly edges: readonly FlowEdgeSpec[];
}): { nodes: FlowNode[]; edges: FlowEdgeModel[] } {
  return {
    nodes: input.nodes.map((spec) => ({
      id: spec.id,
      type: spec.data.kind,
      position: { x: spec.position.x, y: spec.position.y },
      data: spec.data,
    })),
    edges: input.edges.map((spec) => ({
      id: spec.id,
      source: spec.source,
      target: spec.target,
      type: 'flow' as const,
      sourceHandle: spec.source_anchor,
      targetHandle: spec.target_anchor,
      data: spec.data,
    })),
  };
}
