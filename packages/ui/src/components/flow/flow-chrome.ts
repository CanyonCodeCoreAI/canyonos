import { createContext } from 'react';

// The test-id per node is a consumer concern, not node data, and the card is rendered by React
// Flow's `nodeTypes` so a plain prop cannot reach it. Context is what lets a canvas name its own
// scheme (`workflow-node-<id>`) without the shared card knowing about it.
export type NodeTestId = (id: string) => string;

export const defaultNodeTestId: NodeTestId = (id) => `flow-node-${id}`;

export interface FlowChrome {
  readonly nodeTestId: NodeTestId;
}

export const FlowChromeContext = createContext<FlowChrome>({ nodeTestId: defaultNodeTestId });
