import { strToU8, zipSync } from 'fflate';
import type { Page, Route } from '@playwright/test';

import type {
  CreateProjectResult,
  FileMeta,
  ProjectStatus,
  ProjectSummary,
} from '@canyonos/api/projects';
import type {
  ProjectWorkflowDesign,
  ProjectWorkflowDetail,
  ProjectWorkflowSummary,
  WorkflowStatus,
} from '@canyonos/api/workflows';

export const apiBaseUrl = process.env.VITE_API_URL ?? 'http://localhost:3000';
const apiOrigin = new URL(apiBaseUrl).origin;

export interface SourceFile {
  readonly path: string;
  readonly content: string;
}

export interface ProjectFixture extends CreateProjectResult {
  readonly files: readonly FileMeta[];
}

export const CANONICAL_PROJECT_FILES: readonly SourceFile[] = [
  {
    path: 'workflow.py',
    content: 'def root_workflow(request):\n    return route_request(request)\n',
  },
  {
    path: 'nested/secondary.workflow.py',
    content: 'def secondary_workflow(request):\n    return process_secondary(request)\n',
  },
  {
    path: 'agents/router.agent.py',
    content: 'def route_request(request):\n    return request\n',
  },
  {
    path: 'tools/search.tool.py',
    content: 'def search(query):\n    return []\n',
  },
  { path: 'README.md', content: '# Canonical project\n' },
];

export function uniqueProjectName(prefix: string): string {
  return `${prefix} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function projectZip(files: readonly SourceFile[]): Buffer {
  return Buffer.from(
    zipSync(Object.fromEntries(files.map((file) => [file.path, strToU8(file.content)])))
  );
}

async function expectOk(response: { ok(): boolean; status(): number; text(): Promise<string> }) {
  if (!response.ok()) {
    throw new Error(
      `Project fixture request failed (${response.status()}): ${await response.text()}`
    );
  }
}

export async function createProject(
  page: Page,
  token: string,
  {
    name = uniqueProjectName('E2E project'),
    files = CANONICAL_PROJECT_FILES,
  }: { readonly name?: string; readonly files?: readonly SourceFile[] } = {}
): Promise<ProjectFixture> {
  const created = await page.request.post(`${apiBaseUrl}/projects`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { name, files },
  });
  await expectOk(created);
  const result = (await created.json()) as CreateProjectResult;
  return { ...result, files: await getProjectFiles(page, token, result.project.id) };
}

export async function getProjectFiles(
  page: Page,
  token: string,
  project_id: string
): Promise<FileMeta[]> {
  const response = await page.request.get(`${apiBaseUrl}/projects/${project_id}/files`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await expectOk(response);
  return (await response.json()) as FileMeta[];
}

export async function deleteProjectFile(
  page: Page,
  token: string,
  project_id: string,
  file_id: string
): Promise<void> {
  const response = await page.request.delete(
    `${apiBaseUrl}/projects/${project_id}/files/${file_id}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  await expectOk(response);
}

export function workflowByPath(
  fixture: Pick<ProjectFixture, 'workflows'>,
  source_path: string
): ProjectWorkflowSummary {
  const workflow = fixture.workflows.find((candidate) => candidate.source_path === source_path);
  if (!workflow) throw new Error(`Missing workflow fixture for ${source_path}`);
  return workflow;
}

export function fileByPath(fixture: Pick<ProjectFixture, 'files'>, path: string): FileMeta {
  const file = fixture.files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`Missing file fixture for ${path}`);
  return file;
}

export function projectStatus(
  project_id: string,
  status: ProjectStatus['status'],
  error_message: string | null = null
): ProjectStatus {
  return {
    project_id,
    status,
    error_message,
    updated_at: '2026-07-16T12:00:00.000Z',
  };
}

export function workflowDetail(
  workflow: ProjectWorkflowSummary,
  status: WorkflowStatus
): ProjectWorkflowDetail {
  return { ...workflow, status };
}

export function workflowDesign(workflow: ProjectWorkflowSummary): ProjectWorkflowDesign {
  return {
    ...workflow,
    name: workflow.source_path.split('/').at(-1) ?? 'Workflow',
    summary: `Controlled design for ${workflow.source_path}`,
    nodes: [
      {
        id: 'entry',
        position: { x: 0, y: 0 },
        data: {
          kind: 'workflow',
          file: workflow.source_path,
          role: 'Entry',
          tag: 'Entry',
          chips: [],
        },
      },
    ],
    edges: [],
    stats: [
      {
        id: 'components',
        label: 'Components',
        value: 1,
        caption: 'workflow',
        accent: 'workflow',
      },
    ],
  };
}

export async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

export async function failJson(route: Route, message = 'Controlled test failure'): Promise<void> {
  await fulfillJson(route, { error: 'test.failure', message }, 500);
}

export function isApiRequest(route: Route): boolean {
  return new URL(route.request().url()).origin === apiOrigin;
}

export function canonicalDesignPath(project_id: string, workflow_id: string): string {
  return `/projects/${project_id}/workflows/${workflow_id}/design`;
}

export function canonicalDeployPath(project_id: string): string {
  return `/projects/${project_id}/deploy`;
}

export function projectPath(project: ProjectSummary): string {
  return `/projects/${project.id}`;
}

/**
 * Open source folders in the sidebar, by folder path.
 *
 * The tree arrives shut, so a spec that reaches a file inside a folder has to open its folder first
 * — the same click a reader makes. Root-level files need nothing.
 */
export async function openSourceFolders(page: Page, ...paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    await page.getByTestId(`nav-folder-${path}`).click();
  }
}
