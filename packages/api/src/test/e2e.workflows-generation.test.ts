import { describe, expect, test } from 'bun:test';

import { build_stub_result } from '../modules/workflows/workflows.generation.testkit';

// Pure-function coverage for the standalone-server stub. The static analyzer itself is covered in
// e2e.workflows-graph.test.ts.

describe('build_stub_result', () => {
  test('draws actual source agents instead of duplicating the workflow as an agent', () => {
    const result = build_stub_result({
      project_name: 'Portfolio',
      source_path: 'workflows/portfolio_workflow.py',
      files: [
        { path: 'workflows/portfolio_workflow.py', content: 'def workflow(): pass' },
        { path: 'agents/intent_agent.py', content: 'class IntentAgent: pass' },
        { path: 'agents/advisor_agent.py', content: 'class AdvisorAgent: pass' },
        { path: 'README.md', content: '# Portfolio' },
      ],
    });

    expect(result.status).toBe('ready');
    if (result.status === 'failed') return;
    expect(result.design.nodes.map((node) => [node.data.kind, node.data.file])).toEqual([
      ['workflow', 'workflows/portfolio_workflow.py'],
      ['agent', 'agents/intent_agent.py'],
      ['agent', 'agents/advisor_agent.py'],
    ]);
  });
});
