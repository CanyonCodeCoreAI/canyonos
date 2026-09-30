import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, Position } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';

import { edgeColorToken, edgeDashArray, edgeStrokeWidth } from './flow-tokens';
import type { FlowEdgeModel } from './flow-hoc';
import type { FlowEdgeData } from './types';

type EdgeType = FlowEdgeData['edge_type'];

const EDGE_TYPES: readonly EdgeType[] = ['route', 'call', 'loop', 'return'];

// Marker ids stay `wf-arrow-*` so both surfaces resolve the same arrowheads.
function markerId(edgeType: EdgeType): string {
  return `wf-arrow-${edgeType}`;
}

export function FlowEdgeMarkers() {
  return (
    <svg className="pointer-events-none absolute size-0" aria-hidden>
      <defs>
        {EDGE_TYPES.map((edgeType) => (
          <marker
            key={edgeType}
            id={markerId(edgeType)}
            markerWidth={8}
            markerHeight={8}
            refX={6}
            refY={3.5}
            orient="auto"
            markerUnits="userSpaceOnUse"
          >
            <path d="M0 0 L7 3.5 L0 7 Z" style={{ fill: edgeColorToken[edgeType] }} />
          </marker>
        ))}
      </defs>
    </svg>
  );
}

const LABEL_TARGET_OFFSET = 52;

// The label sits on the edge's final approach rather than at the path midpoint: on a fan-out,
// midpoint labels all stack along the shared trunk and say nothing about which branch they name,
// while a label just short of the card reads as that target's caption. A short edge keeps the
// label between the midpoint and the node instead of overshooting past the bend.
function labelPoint(
  labelX: number,
  labelY: number,
  targetX: number,
  targetY: number,
  targetPosition: Position
): { x: number; y: number } {
  if (targetPosition === Position.Left || targetPosition === Position.Right) {
    const direction = targetPosition === Position.Left ? -1 : 1;
    const approach = Math.min(LABEL_TARGET_OFFSET, 0.8 * Math.abs(targetX - labelX));
    return { x: targetX + direction * approach, y: targetY };
  }
  const direction = targetPosition === Position.Top ? -1 : 1;
  const approach = Math.min(LABEL_TARGET_OFFSET, 0.8 * Math.abs(targetY - labelY));
  return { x: targetX, y: targetY + direction * approach };
}

export function FlowEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<FlowEdgeModel>) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 14,
  });

  const edge_type = data?.edge_type ?? 'route';
  const color = edgeColorToken[edge_type];
  const label = labelPoint(labelX, labelY, targetX, targetY, targetPosition);
  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={`url(#${markerId(edge_type)})`}
        style={{
          stroke: color,
          strokeWidth: edgeStrokeWidth[edge_type],
          strokeDasharray: edgeDashArray[edge_type],
        }}
      />
      {data?.label ? (
        <EdgeLabelRenderer>
          <div
            className="bg-muted pointer-events-none absolute rounded-md border px-1.5 py-0.5 font-mono text-[0.6875rem] font-semibold tracking-wide"
            style={{
              transform: `translate(-50%, -50%) translate(${label.x}px, ${label.y}px)`,
              borderColor: `color-mix(in srgb, ${color} 45%, transparent)`,
              color,
            }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
