import { describe, expect, test } from 'bun:test';

import {
  countComponents,
  describeSkipped,
  findEnvFiles,
  READABLE_EXTENSIONS,
  toFileRows,
  TOTAL_SIZE_LIMIT_LABEL,
} from './projects.import-summary';
import type { ParsedFile, ParsedUpload } from './projects.upload';

const file = (path: string): ParsedFile => ({ path, content: '' });

const upload = (skipped: ParsedUpload['skipped']): ParsedUpload => ({
  name: 'demo',
  files: [file('graph.py')],
  skipped,
});

describe('countComponents', () => {
  test('splits python sources into workflows and agents and totals every file', () => {
    const counts = countComponents([
      file('workflows/triage.workflow.py'),
      file('workflows/escalation.workflow.py'),
      file('agents/classifier.py'),
      file('README.md'),
    ]);

    expect(counts).toEqual({ workflows: 2, agents: 1, files: 4 });
  });

  test('counts no components in a project with no python sources', () => {
    const counts = countComponents([file('README.md'), file('config.yaml')]);

    expect(counts).toEqual({ workflows: 0, agents: 0, files: 2 });
  });

  test('is empty for an empty upload', () => {
    expect(countComponents([])).toEqual({ workflows: 0, agents: 0, files: 0 });
  });
});

describe('toFileRows', () => {
  test('sorts by path and reports depth for indentation', () => {
    const rows = toFileRows([file('graph.py'), file('agents/deep/nested.py')]);

    expect(rows.map((row) => [row.path, row.name, row.depth])).toEqual([
      ['agents/deep/nested.py', 'nested.py', 2],
      ['graph.py', 'graph.py', 0],
    ]);
  });

  test('carries the classified kind onto each row', () => {
    const rows = toFileRows([file('my.workflow.py'), file('helper.py'), file('notes.md')]);

    expect(rows.map((row) => row.kind)).toEqual(['agent', 'workflow', 'other']);
  });
});

describe('describeSkipped', () => {
  test('is null when nothing was skipped', () => {
    expect(describeSkipped(upload([]))).toBeNull();
  });

  test('groups the reasons behind the count', () => {
    const described = describeSkipped(
      upload([
        { path: 'a.png', reason: 'unsupported' },
        { path: 'b.png', reason: 'unsupported' },
        { path: 'c.py', reason: 'duplicate' },
      ])
    );

    expect(described).toBe('3 skipped (2 unsupported, 1 duplicate)');
  });
});

describe('findEnvFiles', () => {
  test('finds every env file variant, at any depth', () => {
    expect(
      findEnvFiles([
        file('.env'),
        file('workflow.py'),
        file('service/.env.production'),
        file('.envrc'),
      ])
    ).toEqual(['.env', 'service/.env.production', '.envrc']);
  });

  test('does not match a file that only ends in .env or mentions env', () => {
    expect(findEnvFiles([file('settings.env'), file('env.py'), file('environment.yaml')])).toEqual(
      []
    );
  });

  test('is empty for an upload with no env files', () => {
    expect(findEnvFiles([file('workflow.py')])).toEqual([]);
  });
});

describe('limit copy', () => {
  // The mockup promised ".ts .js" and 200 MB; both would be rejected on admission.
  test('advertises only extensions the API admits', () => {
    // Split rather than substring-match: ".json" contains ".js" without admitting it.
    const advertised = READABLE_EXTENSIONS.split(' ');

    expect(advertised).toContain('.py');
    expect(advertised).toContain('.env*');
    expect(advertised).not.toContain('.ts');
    expect(advertised).not.toContain('.js');
  });

  test('advertises the real total cap', () => {
    expect(TOTAL_SIZE_LIMIT_LABEL).toBe('Up to 5 MB');
  });
});
