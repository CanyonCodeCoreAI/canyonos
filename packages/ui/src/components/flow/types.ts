// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

export type FlowAnchor = 'top' | 'bottom' | 'left' | 'right';
export type FlowNodeKind = 'workflow' | 'agent' | 'tool';

export type FlowNodeChip = { kind: 'components' | 'tools' | 'routes'; label: string };
export type FlowNodeTone = 'ok' | 'warning' | 'down';
export type FlowNodeFooterRow = { icon: 'requires' | 'spend'; label: string };

export type FlowNodeData = {
  kind: FlowNodeKind;
  file: string;
  role: string;
  tag: string | null;
  chips: readonly FlowNodeChip[];
  footer: readonly FlowNodeFooterRow[];
  tone?: FlowNodeTone;
};

export interface FlowNodeSpec {
  id: string;
  position: { x: number; y: number };
  data: FlowNodeData;
}

export type FlowEdgeData = {
  edge_type: 'route' | 'call' | 'loop' | 'return';
  label: string | null;
  // Where the path turns, measured from the source; halfway to the target when unset.
  bend_from_source?: number;
};

export interface FlowEdgeSpec {
  id: string;
  source: string;
  target: string;
  source_anchor: FlowAnchor;
  target_anchor: FlowAnchor;
  data: FlowEdgeData;
}
