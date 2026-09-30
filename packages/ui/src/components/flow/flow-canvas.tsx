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
  'data-testid'?: string;
}

export function FlowCanvas({
  nodes,
  edges,
  showControls = false,
  showEdgeMarkers = false,
  nodeTestId,
  'data-testid': dataTestId,
}: FlowCanvasProps) {
  const flow = toFlow({ nodes, edges });
  const [flowNodes, , onNodesChange] = useNodesState(flow.nodes);
  const [flowEdges, , onEdgesChange] = useEdgesState(flow.edges);

  const chrome = useMemo(() => ({ nodeTestId: nodeTestId ?? defaultNodeTestId }), [nodeTestId]);

  return (
    <FlowChromeContext.Provider value={chrome}>
      <ReactFlowProvider>
        <div className="h-full w-full" data-testid={dataTestId}>
          {showEdgeMarkers ? <FlowEdgeMarkers /> : null}
          <ReactFlow
            nodeTypes={flowNodeTypes}
            edgeTypes={flowEdgeTypes}
            nodes={flowNodes}
            edges={flowEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodesConnectable={false}
            panOnDrag
            selectionOnDrag={false}
            // The design is generated, so a card can be nudged aside to read what it covers but
            // never removed: there is no edit to persist and the next generation restores it.
            deleteKeyCode={null}
            fitView
            proOptions={{ hideAttribution: true }}
            panOnScroll
            minZoom={0.3}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} />
            {showControls ? <Controls showInteractive={false} /> : null}
          </ReactFlow>
        </div>
      </ReactFlowProvider>
    </FlowChromeContext.Provider>
  );
}
