import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

import type {
  DeploymentInfo,
  DeploymentStatus,
  DeployPreview,
  DeployStopCapability,
  ProjectDeploySummary,
} from '@canyonos/api/deploy';
import type { ProjectSummary } from '@canyonos/api/projects';
import type {
  ProjectWorkflowDesign,
  ProjectWorkflowSummary,
  WorkflowStatus,
} from '@canyonos/api/workflows';

const apiOrigin = new URL(process.env.VITE_API_URL ?? 'http://localhost:3000').origin;

export const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
export const DEPLOY_ID = '22222222-2222-4222-8222-222222222222';
export const WORKFLOW_ID = '55555555-5555-4555-8555-555555555555';
export const DEPLOY_ADDRESS = 'https://request-router.example.com';

const deployConfig = {
  id: '33333333-3333-4333-8333-333333333333',
  project_id: PROJECT_ID,
  name: 'AWS Setup Felipe',
  project_name: 'Request Router',
  provider: 1,
  provider_name: 'AWS',
  providers: [{ id: 1, name: 'AWS', enabled: true }],
  status: { readiness: 'ready', label: 'Ready to deploy' },
  // Defaults to a project that has deployed before, so the config → preview flow is the default
  // path; the first-deploy specs override this to false to exercise the direct deploy.
  has_previous_deploy: true,
};

/**
 * Answers the scaling policy and follows it to the emulation.
 *
 * Setting the policy hands over there whatever the project has done before, so there is no ready
 * state to wait for on the policy screen — the emulation arriving is what says it worked. The
 * answers travel with it in the search, so the path is the end of the match and not the URL.
 */
export async function setScalingPlan(page: Page, project_id: string, load = '120'): Promise<void> {
  await page.getByTestId('deploy-expected-load').fill(load);
  await page.getByTestId('deploy-priority').click();
  await page.getByTestId('deploy-plan-set').click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project_id}/deploy/performance\\?`));
}

export interface DeployFrame {
  readonly id: number;
  readonly event: 'phase' | 'succeeded' | 'failed' | 'stopped' | 'stop_failed';
  readonly data: Record<string, unknown>;
}

// Serialise frames exactly as the API's `sse()` helper does: `id`/`event`/`data` lines per frame,
// blank line between frames (see deploy.stream.ts `to_frame`).
export function sseBody(frames: readonly DeployFrame[]): string {
  return (
    frames
      .map(
        (frame) => `id: ${frame.id}\nevent: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n`
      )
      .join('\n') + '\n'
  );
}

const phase = (id: number, status: string): DeployFrame => ({
  id,
  event: 'phase',
  data: { type: 'phase', phase: status },
});

export const RUNNING_FRAMES: readonly DeployFrame[] = [
  phase(1, 'pending'),
  phase(2, 'receiving_files'),
  phase(3, 'processing_files'),
];

export const SUCCESS_FRAMES: readonly DeployFrame[] = [
  ...RUNNING_FRAMES,
  phase(4, 'provisioning_resources'),
  phase(5, 'launching_resources'),
  { id: 6, event: 'succeeded', data: { type: 'succeeded', address: DEPLOY_ADDRESS } },
];

// Teardown replays the whole log — a client following a stop re-receives the deploy's own
// `succeeded` frame before the teardown frames.
export const STOPPED_FRAMES: readonly DeployFrame[] = [
  ...SUCCESS_FRAMES,
  phase(7, 'stopping'),
  { id: 8, event: 'stopped', data: { type: 'stopped', message: null } },
];

// A connection that dies mid-teardown: the stopping phase arrived, no terminal frame followed.
export const STOPPING_DROPPED_FRAMES: readonly DeployFrame[] = [
  ...SUCCESS_FRAMES,
  phase(7, 'stopping'),
];

export const STOP_FAILED_REASON = 'ssh: connect to host 203.0.113.10 port 22: Connection refused';

// The teardown failed — the log ends back on a live deployment.
export const STOP_FAILED_FRAMES: readonly DeployFrame[] = [
  ...SUCCESS_FRAMES,
  phase(7, 'stopping'),
  { id: 8, event: 'stop_failed', data: { type: 'stop_failed', message: STOP_FAILED_REASON } },
];

export const UNVERIFIED_REASON =
  'the controller instance was already gone, so its agent replicas could not be released and may still be running';

// A teardown that finished without proving the replicas went with it.
export const STOPPED_UNVERIFIED_FRAMES: readonly DeployFrame[] = [
  ...SUCCESS_FRAMES,
  phase(7, 'stopping'),
  { id: 8, event: 'stopped', data: { type: 'stopped', message: UNVERIFIED_REASON } },
];

export const FAILED_FRAMES: readonly DeployFrame[] = [
  phase(1, 'pending'),
  phase(2, 'receiving_files'),
  phase(3, 'processing_files'),
  phase(4, 'provisioning_resources'),
  {
    id: 5,
    event: 'failed',
    data: { type: 'failed', message: 'Provisioning failed while installing the agent runtime.' },
  },
];

function isStreamPath(pathname: string): boolean {
  return /\/deploy\/[^/]+\/stream$/.test(pathname);
}

// The deploy routes nest under `/projects/$project_id`, whose loader ensures the project detail. The
// fixed PROJECT_ID isn't a real record, so the flow specs mock its detail to let the parent route
// render its Outlet (the deploy screens) deterministically.
export async function mockProjectDetail(
  page: Page,
  overrides?: Partial<ProjectSummary>
): Promise<void> {
  const body: ProjectSummary = {
    id: PROJECT_ID,
    name: 'Request Router',
    file_count: 5,
    created_at: '2026-07-01T12:00:00.000Z',
    updated_at: '2026-07-01T12:00:00.000Z',
    ...overrides,
  };
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === `/projects/${PROJECT_ID}`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      })
  );
}

export async function mockDeployConfig(
  page: Page,
  overrides?: Partial<typeof deployConfig>
): Promise<void> {
  const body = { ...deployConfig, ...overrides };
  await page.route(
    (url) => url.pathname.endsWith('/deploy/config'),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      })
  );
}

// The status route loads the deployment record by id up front to decide which screen to show — a
// terminal deploy renders its outcome directly, an in-flight one opens the stream. Match ONLY the
// API's GET `/projects/{id}/deploy/{uuid}`: the trailing-uuid anchor excludes `/deploy/config`, the
// `/stream` and `/test` suffixes, and the create route's bare `/deploy`; the origin guard excludes
// the same-path SPA document navigation (mirrors `mockProjectDetail`).
const isDeployInfoPath = (url: URL): boolean =>
  url.origin === apiOrigin && /\/deploy\/[0-9a-f-]{36}$/i.test(url.pathname);

export interface DeployInfoOptions {
  readonly id?: string;
  readonly status: DeploymentStatus;
  readonly address?: string | null;
  readonly error?: string | null;
  readonly stop_error?: string | null;
  readonly stop?: DeployStopCapability;
}

function defaultStopCapability(status: DeploymentStatus): DeployStopCapability {
  if (status === 'success' || status === 'stopping') {
    return { available: true, code: 'available', message: null };
  }
  return { available: false, code: 'not_live', message: 'This deployment is no longer running.' };
}

// The persisted deployment record. Its `status` is what the machine branches on: `success`/`failed`
// render directly with no stream, any in-flight status seeds the view and opens the SSE stream.
export async function mockDeployInfo(
  page: Page,
  { id = DEPLOY_ID, status, address, error, stop_error, stop }: DeployInfoOptions
): Promise<void> {
  await page.route(isDeployInfoPath, (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id,
        project_id: PROJECT_ID,
        status,
        address: address ?? null,
        error: error ?? null,
        stop_error: stop_error ?? null,
        stop: stop ?? defaultStopCapability(status),
        created_at: '2026-07-07T14:20:00.000Z',
        updated_at: '2026-07-07T14:22:00.000Z',
      }),
    });
  });
}

export function deploymentInfo({
  id = DEPLOY_ID,
  status,
  address,
  error,
  stop_error,
  stop,
}: DeployInfoOptions): DeploymentInfo {
  return {
    id,
    project_id: PROJECT_ID,
    status,
    address: address ?? null,
    error: error ?? null,
    stop_error: stop_error ?? null,
    stop: stop ?? defaultStopCapability(status),
    created_at: '2026-07-07T14:20:00.000Z',
    updated_at: '2026-07-07T14:22:00.000Z',
  };
}

const isSummaryPath = (url: URL): boolean =>
  url.origin === apiOrigin && url.pathname.endsWith('/deploy/summary');

/**
 * GET `/projects/{id}/deploy/summary`, the source the header deploy controls read.
 * One summary is served per request and the last one repeats, so a spec can hand the header a
 * deploy that appears between two reads.
 */
export async function mockDeploySummary(
  page: Page,
  ...summaries: readonly ProjectDeploySummary[]
): Promise<void> {
  const timeline: readonly ProjectDeploySummary[] =
    summaries.length > 0 ? summaries : [{ latest: null, active: null }];
  let call = 0;
  await page.route(isSummaryPath, (route) => {
    const summary = timeline[Math.min(call, timeline.length - 1)]!;
    call += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(summary),
    });
  });
}

export async function mockDeploySummaryError(page: Page): Promise<void> {
  await page.route(isSummaryPath, (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'project.not_found', message: 'Project was not found' }),
    })
  );
}

// A 404 on the deploy-by-id load means the id does not resolve; the status screen renders the
// not-found view before any stream is opened (see deploy.machine.ts `loadDeploy` onError).
export async function mockDeployInfoNotFound(page: Page): Promise<void> {
  await page.route(isDeployInfoPath, (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'deploy.not_found' }),
    });
  });
}

// The in-flight status route streams `/projects/{id}/deploy/{deploy_id}/stream`, so the mock matches
// any deploy-id-scoped stream path. Streaming the deploy's full history is what drives which sub-view
// of the status screen shows, so callers hand in the exact frame timeline they want to replay.
export async function mockDeployStream(page: Page, frames: readonly DeployFrame[]): Promise<void> {
  await page.route(
    (url) => isStreamPath(url.pathname),
    (route) =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: sseBody(frames) })
  );
}

/** Serves a different frame list per stream connection (the last list repeats). */
export async function mockDeployStreamSequence(
  page: Page,
  connections: readonly (readonly DeployFrame[])[]
): Promise<void> {
  let call = 0;
  await page.route(
    (url) => isStreamPath(url.pathname),
    (route) => {
      const frames = connections[Math.min(call, connections.length - 1)]!;
      call += 1;
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseBody(frames),
      });
    }
  );
}

// Guard on POST so the SPA document request for `/projects/{id}/deploy` (same pathname suffix) still
// loads the app instead of being answered with the trigger's JSON envelope.
export async function mockDeployTrigger(page: Page, deployId: string): Promise<void> {
  await page.route(
    (url) => url.pathname.endsWith('/deploy'),
    (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      return route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          deploy_id: deployId,
          project_id: PROJECT_ID,
          status: 'accepted',
          file_count: 3,
        }),
      });
    }
  );
}

// A 409 `deploy.already_running` carries no deploy id, so the create screen shows an inline error and
// stays put. The envelope matches the API's `AppError` shape (`error`/`message`) that `apiCall` reads.
export async function mockDeployTriggerConflict(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.endsWith('/deploy'),
    (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'deploy.already_running',
          message: 'A deployment is already running for this project.',
        }),
      });
    }
  );
}

// The `/test` proxy always answers HTTP 200 with the upstream outcome envelope (`ok`/`status`/`body`);
// `status` is the deployed endpoint's status, so a non-2xx `status` still arrives as a 200 the UI
// renders as a failed probe (see deploy.service.ts `test_deployment`).
export async function mockDeployTest(
  page: Page,
  result: { status?: number; body?: unknown } = {}
): Promise<void> {
  const status = result.status ?? 200;
  const body = result.body ?? { response: { answer: 'Use the reset link on the sign-in screen.' } };
  await page.route(
    (url) => /\/deploy\/[^/]+\/test$/.test(url.pathname),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: status >= 200 && status < 300, status, body }),
      })
  );
}

export const BASE_DEPLOY_ID = '44444444-4444-4444-8444-444444444444';
export const PREVIEW_BASE_CREATED_AT = '2026-07-05T09:30:00.000Z';

// A modified file whose single changed row carries both sides — the `-`/`+` markers and the
// side-by-side Before/After content the preview specs assert against.
export const PREVIEW_MODIFIED_FILE: DeployPreview['files'][number] = {
  path: 'agents/router.agent.py',
  component_kind: 'agent',
  change: 'modified',
  rows: [
    {
      kind: 'unchanged',
      old_line: 1,
      new_line: 1,
      old_text: 'def route_request(request):',
      new_text: 'def route_request(request):',
    },
    {
      kind: 'changed',
      old_line: 2,
      new_line: 2,
      old_text: '    return request',
      new_text: '    return handoff(request)',
    },
  ],
};

export const PREVIEW_ADDED_FILE: DeployPreview['files'][number] = {
  path: 'tools/search.tool.py',
  component_kind: 'tool',
  change: 'added',
  rows: [
    { kind: 'added', old_line: null, new_line: 1, old_text: null, new_text: 'def search(query):' },
    { kind: 'added', old_line: null, new_line: 2, old_text: null, new_text: '    return []' },
  ],
};

export const PREVIEW_REMOVED_FILE: DeployPreview['files'][number] = {
  path: 'legacy/old.tool.py',
  component_kind: 'tool',
  change: 'removed',
  rows: [
    { kind: 'removed', old_line: 1, new_line: null, old_text: 'def old_tool():', new_text: null },
  ],
};

// A preview with one added, one removed, and one modified file against a prior successful deploy.
export const previewWithAllChanges = (): DeployPreview => ({
  base_deployment_id: BASE_DEPLOY_ID,
  base_created_at: PREVIEW_BASE_CREATED_AT,
  has_changes: true,
  summary: { added: 1, removed: 1, modified: 1 },
  files: [PREVIEW_ADDED_FILE, PREVIEW_MODIFIED_FILE, PREVIEW_REMOVED_FILE],
});

// The first-ever deploy: no base, every current file is new.
export const previewFirstDeploy = (): DeployPreview => ({
  base_deployment_id: null,
  base_created_at: null,
  has_changes: true,
  summary: { added: 2, removed: 0, modified: 0 },
  files: [
    PREVIEW_ADDED_FILE,
    { ...PREVIEW_MODIFIED_FILE, path: 'workflow.py', component_kind: 'workflow', change: 'added' },
  ],
});

// Nothing changed since the last successful deploy — no files, all summary counts zero.
export const previewNoChanges = (): DeployPreview => ({
  base_deployment_id: BASE_DEPLOY_ID,
  base_created_at: PREVIEW_BASE_CREATED_AT,
  has_changes: false,
  summary: { added: 0, removed: 0, modified: 0 },
  files: [],
});

// GET `/projects/{id}/deploy/preview`. Guard on the API origin so the SPA document navigation to the
// same pathname still loads the app, and on GET so it never answers a different method.
const isPreviewPath = (url: URL): boolean =>
  url.origin === apiOrigin && url.pathname.endsWith('/deploy/preview');

export async function mockDeployPreview(page: Page, preview: DeployPreview): Promise<void> {
  await page.route(isPreviewPath, (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(preview),
    });
  });
}

export async function mockDeployPreviewError(page: Page): Promise<void> {
  await page.route(isPreviewPath, (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'test.failure', message: 'Controlled preview failure' }),
    });
  });
}

/**
 * The project's workflow list, ready by default.
 *
 * The status is what the emulation gates its design request on, so a spec that wants the run to
 * start has to say the design exists. Pass a generating status to hold the screen on its waiting
 * state instead.
 */
export async function mockDeployWorkflows(
  page: Page,
  status: WorkflowStatus = 'READY'
): Promise<void> {
  const workflow: ProjectWorkflowSummary = {
    id: WORKFLOW_ID,
    project_id: PROJECT_ID,
    source_file_id: WORKFLOW_ID,
    source_path: 'workflow.py',
    updated_at: '2026-07-01T12:00:00.000Z',
    status,
  };
  await page.route(
    (url) => url.pathname.endsWith('/workflows'),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([workflow]),
      })
  );
}

/** The design the emulation sends traffic down: an entry into one agent, which calls the model. */
export function deployWorkflowDesign(): ProjectWorkflowDesign {
  return {
    id: WORKFLOW_ID,
    project_id: PROJECT_ID,
    source_file_id: WORKFLOW_ID,
    source_path: 'workflow.py',
    updated_at: '2026-07-01T12:00:00.000Z',
    name: 'workflow.py',
    summary: 'Controlled design for the emulation.',
    stats: [],
    nodes: [
      {
        id: 'entry',
        position: { x: 0, y: 0 },
        data: { kind: 'workflow', file: 'workflow.py', role: 'Entry', tag: 'Entry', chips: [] },
      },
      {
        id: 'agent',
        position: { x: 220, y: 0 },
        data: { kind: 'agent', file: 'agent.py', role: 'Agent', tag: null, chips: [] },
      },
    ],
    edges: [
      {
        id: 'entry-agent',
        source: 'entry',
        target: 'agent',
        source_anchor: 'right',
        target_anchor: 'left',
        data: { edge_type: 'route', label: null },
      },
    ],
  };
}

export async function mockDeployWorkflowDesign(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.endsWith(`/workflows/${WORKFLOW_ID}/design`),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(deployWorkflowDesign()),
      })
  );
}

function isStopPath(pathname: string): boolean {
  return /\/deploy\/[^/]+\/stop$/.test(pathname);
}

/** Accepts the teardown request, recording each call so a spec can assert it fired exactly once. */
export async function mockDeployStop(page: Page): Promise<{ calls: () => number }> {
  let calls = 0;
  await page.route(
    (url) => isStopPath(url.pathname),
    (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      calls += 1;
      return route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ deploy_id: DEPLOY_ID, project_id: PROJECT_ID, status: 'stopping' }),
      });
    }
  );
  return { calls: () => calls };
}

export async function mockDeployStopConflict(
  page: Page,
  error = 'deploy.not_stoppable'
): Promise<void> {
  await page.route(
    (url) => isStopPath(url.pathname),
    (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error }),
      });
    }
  );
}
