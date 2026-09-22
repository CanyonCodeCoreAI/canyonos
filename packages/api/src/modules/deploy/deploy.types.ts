import { z } from 'zod';

import { FileComponentKindSchema } from '../projects/projects.types';

export enum DeployProviderId {
  AWS = 1,
  GCP = 2,
}

export const TriggerDeployBodySchema = z.object({}).strict().optional();

// The deployed agent takes a single natural-language prompt: `POST /main {"query": "..."}`. The
// dashboard "Test" panel sends the raw textarea text, so this schema is the whole request contract.
export const DeployTestBodySchema = z
  .object({ query: z.string().trim().min(1, 'Enter a query to send to the deployed agent') })
  .strict();

export const DeployProviderSchema = z.object({
  id: z.nativeEnum(DeployProviderId),
  name: z.string(),
  enabled: z.boolean(),
});

export const DeployConfigSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  name: z.string(),
  project_name: z.string(),
  provider: z.nativeEnum(DeployProviderId),
  provider_name: z.string(),
  providers: z.array(DeployProviderSchema),
  status: z.object({ readiness: z.literal('ready'), label: z.string() }),
  // A prior successful deployment exists, so the pre-deploy diff has a baseline to compare against.
  // When false this is the first deploy — the dashboard skips the review step and deploys directly.
  has_previous_deploy: z.boolean(),
});

// Mirrors the `deployment_status` pg enum in the exact same order — the lifecycle sequence the
// systems worker drives. `DEPLOYMENT_STATUSES` is the single source both the schema and the Python
// codegen derive from. New statuses go at the end: `ALTER TYPE ... ADD VALUE` appends, and
// test_contracts.py asserts this tuple equals the pg enum's sort order.
export const DEPLOYMENT_STATUSES = [
  'pending',
  'receiving_files',
  'processing_files',
  'provisioning_resources',
  'launching_resources',
  'success',
  'failed',
  'stopping',
  'stopped',
  'stop_failed',
] as const;

export const DeploymentStatusSchema = z.enum(DEPLOYMENT_STATUSES);

// The single source for "this run is over" — the repo's SQL filters, the SSE stream's close
// condition, and the dashboard's active/resume logic all derive from it.
export const TERMINAL_DEPLOYMENT_STATUSES = [
  'success',
  'failed',
  'stopped',
] as const satisfies readonly [
  (typeof DEPLOYMENT_STATUSES)[number],
  ...(typeof DEPLOYMENT_STATUSES)[number][],
];

type TerminalStatus = (typeof TERMINAL_DEPLOYMENT_STATUSES)[number];
type NonPhaseStatus = TerminalStatus | 'stop_failed';

export function is_terminal_deployment_status(status: DeploymentStatus): boolean {
  return (TERMINAL_DEPLOYMENT_STATUSES as readonly DeploymentStatus[]).includes(status);
}

export const DEPLOYMENT_PHASES = DEPLOYMENT_STATUSES.filter(
  (status) =>
    !(TERMINAL_DEPLOYMENT_STATUSES as readonly string[]).includes(status) &&
    status !== 'stop_failed'
) as [
  Exclude<(typeof DEPLOYMENT_STATUSES)[number], NonPhaseStatus>,
  ...Exclude<(typeof DEPLOYMENT_STATUSES)[number], NonPhaseStatus>[],
];

export const DeploymentPhaseSchema = z.enum(DEPLOYMENT_PHASES);

// Persisted event payload and codegen source for the Python worker's pydantic mirror.
export const DeployEventPayloadSchema = z.object({
  deployment_id: z.string().uuid(),
  seq: z.number().int(),
  status: DeploymentStatusSchema,
  detail: z.string().nullable(),
});

// PostgreSQL NOTIFY stays below its payload limit regardless of event detail size. Consumers fetch
// the committed event row identified by this notification before publishing it to SSE subscribers.
export const DeployEventNotificationSchema = DeployEventPayloadSchema.pick({
  deployment_id: true,
  seq: true,
});

export const DeploySseFrameIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:\d+$/i);

export const DeploySsePhaseFrameSchema = z.object({
  id: DeploySseFrameIdSchema,
  event: z.literal('phase'),
  data: z.object({ type: z.literal('phase'), phase: DeploymentPhaseSchema }),
});

export const DeploySseSucceededFrameSchema = z.object({
  id: DeploySseFrameIdSchema,
  event: z.literal('succeeded'),
  data: z.object({ type: z.literal('succeeded'), address: z.string().nullable() }),
});

export const DeploySseFailedFrameSchema = z.object({
  id: DeploySseFrameIdSchema,
  event: z.literal('failed'),
  data: z.object({ type: z.literal('failed'), message: z.string().nullable() }),
});

// `message` is set when the teardown finished without proving the agent replicas were released.
export const DeploySseStoppedFrameSchema = z.object({
  id: DeploySseFrameIdSchema,
  event: z.literal('stopped'),
  data: z.object({ type: z.literal('stopped'), message: z.string().nullable() }),
});

// The deployment is still live; `message` names why the teardown did not finish.
export const DeploySseStopFailedFrameSchema = z.object({
  id: DeploySseFrameIdSchema,
  event: z.literal('stop_failed'),
  data: z.object({ type: z.literal('stop_failed'), message: z.string().nullable() }),
});

export const DeploySseFrameSchema = z.discriminatedUnion('event', [
  DeploySsePhaseFrameSchema,
  DeploySseSucceededFrameSchema,
  DeploySseFailedFrameSchema,
  DeploySseStoppedFrameSchema,
  DeploySseStopFailedFrameSchema,
]);

export const ProjectDeployAcceptedSchema = z.object({
  deploy_id: z.string().uuid(),
  project_id: z.string().uuid(),
  status: z.literal('accepted'),
  file_count: z.number().int().nonnegative(),
});

export const DeployStopAcceptedSchema = z.object({
  deploy_id: z.string().uuid(),
  project_id: z.string().uuid(),
  status: z.literal('stopping'),
});

export const DeployStopCapabilityCodeSchema = z.enum([
  'available',
  'not_live',
  'missing_controller_identity',
]);

export const DeployStopCapabilitySchema = z.object({
  available: z.boolean(),
  code: DeployStopCapabilityCodeSchema,
  message: z.string().nullable(),
});

// The proxied test-request outcome. `ok`/`status` describe the upstream HTTP response; `body` is its
// payload parsed as JSON when possible, else the raw text — the UI renders it verbatim.
export const DeployTestResultSchema = z.object({
  ok: z.boolean(),
  status: z.number().int(),
  body: z.unknown(),
});

// A deployment's persisted record. The dashboard loads this to decide which screen to show — a
// terminal deploy renders its outcome directly, an in-flight one opens the progress stream — so the
// status is known up front rather than replayed.
export const DeploymentInfoSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  status: DeploymentStatusSchema,
  address: z.string().nullable(),
  error: z.string().nullable(),
  stop_error: z.string().nullable(),
  stop: DeployStopCapabilitySchema,
  created_at: z.string(),
  updated_at: z.string(),
});

export const ProjectDeploySummarySchema = z.object({
  latest: DeploymentInfoSchema.nullable(),
  active: DeploymentInfoSchema.nullable(),
});

export const DeploymentOverviewItemSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  project_name: z.string(),
  status: DeploymentStatusSchema,
  address: z.string().nullable(),
  error: z.string().nullable(),
  stop_error: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

// `active` is every non-terminal status; `success`/`failed` match exactly; `all` drops the filter.
export const DEPLOYMENT_STATE_FILTERS = ['active', 'success', 'failed', 'all'] as const;
export const DeploymentStateFilterSchema = z.enum(DEPLOYMENT_STATE_FILTERS);

// One aligned line of a side-by-side file diff. `changed` carries both sides on the same row; a row
// present on only one side leaves the absent side's line number and text null. The dashboard renders
// these rows verbatim — no diffing happens on the client.
export const DiffRowSchema = z.object({
  kind: z.enum(['unchanged', 'added', 'removed', 'changed']),
  old_line: z.number().int().positive().nullable(),
  new_line: z.number().int().positive().nullable(),
  old_text: z.string().nullable(),
  new_text: z.string().nullable(),
});

export const DeployPreviewFileSchema = z.object({
  path: z.string(),
  component_kind: FileComponentKindSchema,
  change: z.enum(['added', 'removed', 'modified']),
  rows: z.array(DiffRowSchema),
});

// How a project's current files differ from its last successful deployment. `files` lists only the
// changed files, sorted by path; unchanged files are omitted. With no prior success `base_*` are null
// and every current file is `added`.
export const DeployPreviewSchema = z.object({
  base_deployment_id: z.string().uuid().nullable(),
  base_created_at: z.string().nullable(),
  has_changes: z.boolean(),
  summary: z.object({
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    modified: z.number().int().nonnegative(),
  }),
  files: z.array(DeployPreviewFileSchema),
});

export type TriggerDeployPayload = z.infer<typeof TriggerDeployBodySchema>;
export type DeployTestBody = z.infer<typeof DeployTestBodySchema>;
export type DeployProvider = z.infer<typeof DeployProviderSchema>;
export type DeployConfig = z.infer<typeof DeployConfigSchema>;
export type ProjectDeployAccepted = z.infer<typeof ProjectDeployAcceptedSchema>;
export type DeployStopAccepted = z.infer<typeof DeployStopAcceptedSchema>;
export type DeployStopCapabilityCode = z.infer<typeof DeployStopCapabilityCodeSchema>;
export type DeployStopCapability = z.infer<typeof DeployStopCapabilitySchema>;
export type DeployTestResult = z.infer<typeof DeployTestResultSchema>;
export type DeploymentInfo = z.infer<typeof DeploymentInfoSchema>;
export type ProjectDeploySummary = z.infer<typeof ProjectDeploySummarySchema>;
export type DeploymentOverviewItem = z.infer<typeof DeploymentOverviewItemSchema>;
export type DeploymentStateFilter = z.infer<typeof DeploymentStateFilterSchema>;
export type DeploymentStatus = z.infer<typeof DeploymentStatusSchema>;
export type DeploymentPhase = z.infer<typeof DeploymentPhaseSchema>;
export type DeployEventPayload = z.infer<typeof DeployEventPayloadSchema>;
export type DeployEventNotification = z.infer<typeof DeployEventNotificationSchema>;
export type DeploySsePhaseFrame = z.infer<typeof DeploySsePhaseFrameSchema>;
export type DeploySseSucceededFrame = z.infer<typeof DeploySseSucceededFrameSchema>;
export type DeploySseFailedFrame = z.infer<typeof DeploySseFailedFrameSchema>;
export type DeploySseStoppedFrame = z.infer<typeof DeploySseStoppedFrameSchema>;
export type DeploySseStopFailedFrame = z.infer<typeof DeploySseStopFailedFrameSchema>;
export type DeploySseFrame = z.infer<typeof DeploySseFrameSchema>;
export type DiffRow = z.infer<typeof DiffRowSchema>;
export type DeployPreviewFile = z.infer<typeof DeployPreviewFileSchema>;
export type DeployPreview = z.infer<typeof DeployPreviewSchema>;
