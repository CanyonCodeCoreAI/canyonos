import { describe, expect, test } from 'bun:test';

import type { FileMeta } from '@cc-forge/api/projects';

import { buildFileTree } from './projects.file-tree';

const meta = (
  id: string,
  path: string,
  component_kind: FileMeta['component_kind'] = 'other'
): FileMeta => ({
  id,
  path,
  name: path.split('/').pop()!,
  language: path.endsWith('.py') ? 'python' : 'text',
  byte_size: 1,
  component_kind,
  updated_at: '2026-07-09T00:00:00.000Z',
});

describe('buildFileTree', () => {
  test('uses persisted component_kind instead of classifying filenames', () => {
    const rows = buildFileTree([
      meta('ordinary', 'workflow.py', 'other'),
      meta('workflow', 'runner.py', 'workflow'),
    ]);
    expect(rows.find((row) => row.id === 'ordinary')?.tone).toBe('other');
    expect(rows.find((row) => row.id === 'workflow')?.tone).toBe('workflow');
  });

  test('orders folders before files and exposes depth and file_id for leaves', () => {
    const rows = buildFileTree([
      meta('w', 'workflow.py', 'workflow'),
      meta('t', 'tools/search.tool.py', 'tool'),
      meta('a', 'agents/router.agent.py', 'agent'),
    ]);
    expect(rows.map((r) => `${r.kind}:${r.name}`)).toEqual([
      'file:workflow.py',
      'folder:agents',
      'folder:tools',
    ]);
    const agents = rows.find((row) => row.kind === 'folder' && row.name === 'agents')!;
    expect(agents.kind).toBe('folder');
    if (agents.kind !== 'folder') throw new Error('Expected agents folder');
    const leaf = agents.children[0]!;
    expect(leaf.kind).toBe('file');
    if (leaf.kind !== 'file') throw new Error('Expected agent source');
    expect(leaf.depth).toBe(1);
    expect(leaf.file_id).toBe('a');
    expect(leaf.component_kind).toBe('agent');
  });

  test('builds independently addressable nested folders', () => {
    const rows = buildFileTree([
      meta('nested-agent', 'agents/specialists/router.agent.py', 'agent'),
    ]);
    const agents = rows[0]!;
    expect(agents).toMatchObject({ id: 'dir:agents/', path: 'agents', depth: 0 });
    if (agents.kind !== 'folder') throw new Error('Expected agents folder');
    const specialists = agents.children[0]!;
    expect(specialists).toMatchObject({
      id: 'dir:agents/specialists/',
      path: 'agents/specialists',
      depth: 1,
    });
    if (specialists.kind !== 'folder') throw new Error('Expected specialists folder');
    expect(specialists.children[0]).toMatchObject({
      id: 'nested-agent',
      kind: 'file',
      depth: 2,
    });
  });
});
