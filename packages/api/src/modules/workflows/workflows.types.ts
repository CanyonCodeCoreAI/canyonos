import { z } from 'zod';

const WorkflowComponentKindSchema = z.enum(['workflow', 'agent', 'tool']);
const WorkflowEdgeTypeSchema = z.enum(['route', 'call', 'loop', 'return']);
const FlowAnchorSchema = z.enum(['top', 'bottom', 'left', 'right']);
const WorkflowChipKindSchema = z.enum(['components', 'tools', 'routes']);
const WorkflowStatIdSchema = z.enum(['components', 'agents', 'tools', 'routes', 'loops']);
const WorkflowStatAccentSchema = z.enum(['workflow', 'agent', 'tool', 'route', 'loop']);

const WorkflowNodeChipSchema = z.object({
  kind: WorkflowChipKindSchema,
  label: z.string(),
});

const WorkflowNodeDataSchema = z.object({
  kind: WorkflowComponentKindSchema,
  file: z.string(),
  role: z.string(),
  tag: z.string().nullable(),
  chips: z.array(WorkflowNodeChipSchema),
});

export const WorkflowFlowNodeSchema = z.object({
  id: z.string(),
  position: z.object({ x: z.number(), y: z.number() }),
  data: WorkflowNodeDataSchema,
});

const WorkflowEdgeDataSchema = z.object({
  edge_type: WorkflowEdgeTypeSchema,
  label: z.string().nullable(),
});

export const WorkflowFlowEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  source_anchor: FlowAnchorSchema,
  target_anchor: FlowAnchorSchema,
  data: WorkflowEdgeDataSchema,
});

export const WorkflowStatSchema = z.object({
  id: WorkflowStatIdSchema,
  label: z.string(),
  value: z.number().int(),
  caption: z.string(),
  accent: WorkflowStatAccentSchema,
});

export const WorkflowStatusSchema = z.enum(['PENDING', 'GENERATING', 'READY', 'FAILED']);

// What the generator produces: the graph itself, and the figures the design header reads.
export const WorkflowGeneratedDesignSchema = z.object({
  nodes: z.array(WorkflowFlowNodeSchema),
  edges: z.array(WorkflowFlowEdgeSchema),
});

export const WorkflowGeneratedStatsSchema = z.object({
  name: z.string(),
  workflow_file: z.string(),
  summary: z.string(),
  stats: z.array(WorkflowStatSchema),
});

// What a workflow row stores. The stats half is optional because a design persisted before the
// stats existed still has to load.
export const WorkflowDesignPayloadSchema = WorkflowGeneratedDesignSchema.extend({
  name: z.string().optional(),
  summary: z.string().optional(),
  stats: z.array(WorkflowStatSchema).optional(),
});

const ProjectWorkflowBaseSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  source_file_id: z.string().uuid(),
  source_path: z.string(),
  updated_at: z.string(),
});

export const ProjectWorkflowSummarySchema = ProjectWorkflowBaseSchema.extend({
  status: WorkflowStatusSchema,
});

export const ProjectWorkflowDetailSchema = ProjectWorkflowSummarySchema;

export const ProjectWorkflowDesignSchema = ProjectWorkflowBaseSchema.merge(
  WorkflowGeneratedDesignSchema
).extend({
  name: z.string(),
  summary: z.string(),
  stats: z.array(WorkflowStatSchema),
});

export type WorkflowComponentKind = z.infer<typeof WorkflowComponentKindSchema>;
export type WorkflowEdgeType = z.infer<typeof WorkflowEdgeTypeSchema>;
export type FlowAnchor = z.infer<typeof FlowAnchorSchema>;
export type WorkflowChipKind = z.infer<typeof WorkflowChipKindSchema>;
export type WorkflowStatId = z.infer<typeof WorkflowStatIdSchema>;
export type WorkflowStatAccent = z.infer<typeof WorkflowStatAccentSchema>;

export type WorkflowNodeChip = z.infer<typeof WorkflowNodeChipSchema>;
export type WorkflowNodeData = z.infer<typeof WorkflowNodeDataSchema>;
export type WorkflowFlowNode = z.infer<typeof WorkflowFlowNodeSchema>;
export type WorkflowEdgeData = z.infer<typeof WorkflowEdgeDataSchema>;
export type WorkflowFlowEdge = z.infer<typeof WorkflowFlowEdgeSchema>;
export type WorkflowStat = z.infer<typeof WorkflowStatSchema>;

export type WorkflowGeneratedDesignPayload = z.infer<typeof WorkflowGeneratedDesignSchema>;
export type WorkflowGeneratedStatsPayload = z.infer<typeof WorkflowGeneratedStatsSchema>;
export type WorkflowDesignPayload = z.infer<typeof WorkflowDesignPayloadSchema>;

export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;
export type ProjectWorkflowSummary = z.infer<typeof ProjectWorkflowSummarySchema>;
export type ProjectWorkflowDetail = z.infer<typeof ProjectWorkflowDetailSchema>;
export type ProjectWorkflowDesign = z.infer<typeof ProjectWorkflowDesignSchema>;
