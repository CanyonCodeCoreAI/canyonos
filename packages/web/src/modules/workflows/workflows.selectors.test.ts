import { describe, expect, test } from 'bun:test';

import type { FileMeta } from '@canyonos/api/projects';
import type { ProjectWorkflowDesign, ProjectWorkflowSummary } from '@canyonos/api/workflows';

import { buildWorkflowViewModel, normalizeFileSelection } from './workflows.selectors';

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const ACTIVE_WORKFLOW_ID = '00000000-0000-4000-8000-000000000002';
const OTHER_WORKFLOW_ID = '00000000-0000-4000-8000-000000000003';
const ACTIVE_SOURCE_ID = '00000000-0000-4000-8000-000000000004';
const OTHER_SOURCE_ID = '00000000-0000-4000-8000-000000000005';
const AGENT_ID = '00000000-0000-4000-8000-000000000006';
const MISSING_ID = '00000000-0000-4000-8000-000000000007';

const active_workflow: ProjectWorkflowSummary = {
  id: ACTIVE_WORKFLOW_ID,
  project_id: PROJECT_ID,
  source_file_id: ACTIVE_SOURCE_ID,
  source_path: 'workflow.py',
  updated_at: '2026-07-16T00:00:00.000Z',
  status: 'READY',
};
const other_workflow: ProjectWorkflowSummary = {
  id: OTHER_WORKFLOW_ID,
  project_id: PROJECT_ID,
  source_file_id: OTHER_SOURCE_ID,
  source_path: 'nested/router.workflow.py',
  updated_at: '2026-07-16T00:00:00.000Z',
  status: 'READY',
};

function file(id: string, path: string, component_kind: FileMeta['component_kind']): FileMeta {
  return {
    id,
    path,
    name: path.split('/').at(-1)!,
    language: 'python',
    byte_size: 10,
    component_kind,
    updated_at: '2026-07-16T00:00:00.000Z',
  };
}

const files = [
  file(ACTIVE_SOURCE_ID, 'workflow.py', 'workflow'),
  file(OTHER_SOURCE_ID, 'nested/router.workflow.py', 'workflow'),
  file(AGENT_ID, 'agents/router.agent.py', 'agent'),
];
const workflows = [active_workflow, other_workflow];

describe('file selection normalization', () => {
  test('uses the active source when file_id is absent', () => {
    expect(normalizeFileSelection({ active_workflow, workflows, files })).toEqual({
      kind: 'active_source',
      file_id: ACTIVE_SOURCE_ID,
    });
  });

  test('clears an explicit active-source file_id', () => {
    expect(
      normalizeFileSelection({
        selected_file_id: ACTIVE_SOURCE_ID,
        active_workflow,
        workflows,
        files,
      })
    ).toEqual({ kind: 'active_source', file_id: ACTIVE_SOURCE_ID });
  });

  test('keeps an agent source in the active workflow code panel', () => {
    expect(
      normalizeFileSelection({
        selected_file_id: AGENT_ID,
        active_workflow,
        workflows,
        files,
      })
    ).toEqual({ kind: 'auxiliary', file_id: AGENT_ID });
  });

  test('moves another workflow source to that workflow design', () => {
    expect(
      normalizeFileSelection({
        selected_file_id: OTHER_SOURCE_ID,
        active_workflow,
        workflows,
        files,
      })
    ).toEqual({ kind: 'other_workflow', workflow_id: OTHER_WORKFLOW_ID });
  });

  test('rejects malformed file_id values', () => {
    expect(
      normalizeFileSelection({
        selected_file_id: 'not-a-uuid',
        active_workflow,
        workflows,
        files,
      })
    ).toEqual({ kind: 'invalid', message: 'The selected source reference is malformed.' });
  });

  test.each(['unknown', 'deleted', 'foreign'])('%s file_id restores the active source', () => {
    expect(
      normalizeFileSelection({
        selected_file_id: MISSING_ID,
        active_workflow,
        workflows,
        files,
      })
    ).toEqual({
      kind: 'invalid',
      message: 'The selected source is unavailable or does not belong to this project.',
    });
  });
});

describe('workflow view model', () => {
  test('uses nested design presentation data and includes loop legend only when present', () => {
    const design: ProjectWorkflowDesign = {
      ...active_workflow,
      name: 'Request router',
      summary: 'Routes requests to the right agent.',
      nodes: [],
      edges: [],
      stats: [
        {
          id: 'loops',
          label: 'Loops',
          value: 1,
          caption: 'Retry loop',
          accent: 'loop',
        },
      ],
    };

    const model = buildWorkflowViewModel(design);
    expect(model.hero).toEqual({ name: 'Request router', workflow_file: 'workflow.py' });
    expect(model.summary).toBe('Routes requests to the right agent.');
    expect(model.component_legend.map((item) => item.id)).toEqual(['workflow', 'agent', 'tool']);
    expect(model.edge_legend.map((item) => item.id)).toEqual(['route', 'call', 'loop', 'return']);
  });
});
