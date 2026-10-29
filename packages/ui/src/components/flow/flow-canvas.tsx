// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';
import { useMemo } from 'react';
import type { KeyboardEvent } from 'react';

import '@xyflow/react/dist/style.css';

import { defaultNodeTestId, FlowChromeContext } from './flow-chrome';
import { FlowEdgeMarkers } from './flow-edge';
import { flowEdgeTypes, flowNodeTypes, toFlow } from './flow-hoc';
import type { NodeTestId } from './flow-chrome';
import type { FlowEdgeSpec, FlowNodeSpec } from './types';

export interface FlowCanvasProps {
  nodes: readonly FlowNodeSpec[];
  edges: readonly FlowEdgeSpec[];
  showControls?: boolean;
  showEdgeMarkers?: boolean;
  nodeTestId?: NodeTestId;
  onNodeClick?: (id: string) => void;
  'data-testid'?: string;
}

function activatedNodeId(event: KeyboardEvent<HTMLDivElement>): string | undefined {
  if (event.key !== 'Enter' && event.key !== ' ') return undefined;
  const { target } = event;
  if (!(target instanceof HTMLElement) || !target.classList.contains('react-flow__node')) {
    return undefined;
  }
  return target.dataset.id;
}

export function FlowCanvas(props: FlowCanvasProps) {
  const nodeSetKey = props.nodes
    .map((node) => node.id)
    .sort()
    .join('\n');
  return <FlowCanvasBody key={nodeSetKey} {...props} />;
}

function FlowCanvasBody({
  nodes,
  edges,
  showControls = false,
  showEdgeMarkers = false,
  nodeTestId,
  onNodeClick,
  'data-testid': dataTestId,
}: FlowCanvasProps) {
  const flow = toFlow({ nodes, edges });
  const [flowNodes, , onNodesChange] = useNodesState(flow.nodes);
  const [flowEdges, , onEdgesChange] = useEdgesState(flow.edges);
  const latestById = new Map(flow.nodes.map((node) => [node.id, node]));
  const liveNodes = flowNodes.map((node) => ({
    ...node,
    data: latestById.get(node.id)?.data ?? node.data,
  }));

  const chrome = useMemo(() => ({ nodeTestId: nodeTestId ?? defaultNodeTestId }), [nodeTestId]);

  return (
    <FlowChromeContext.Provider value={chrome}>
      <ReactFlowProvider>
        <div
          className="bg-flow-canvas h-full w-full antialiased"
          data-testid={dataTestId}
          onKeyDown={(event) => {
            const id = activatedNodeId(event);
            if (id && onNodeClick) onNodeClick(id);
          }}
        >
          {showEdgeMarkers ? <FlowEdgeMarkers /> : null}
          <ReactFlow
            nodeTypes={flowNodeTypes}
            edgeTypes={flowEdgeTypes}
            nodes={liveNodes}
            edges={flowEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick ? (_event, node) => onNodeClick(node.id) : undefined}
            nodesConnectable={false}
            panOnDrag
            selectionOnDrag={false}
            // The design is generated, so a card can be nudged aside to read what it covers but
            // never removed: there is no edit to persist and the next generation restores it.
            deleteKeyCode={null}
            fitView
            fitViewOptions={{ maxZoom: 0.85, padding: 0.3 }}
            proOptions={{ hideAttribution: true }}
            panOnScroll
            minZoom={0.3}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={20}
              size={1}
              color="var(--flow-grid)"
            />
            {showControls ? <Controls showInteractive={false} /> : null}
          </ReactFlow>
        </div>
      </ReactFlowProvider>
    </FlowChromeContext.Provider>
  );
}
