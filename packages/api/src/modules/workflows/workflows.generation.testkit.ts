// Home for stubbing workflow generation. The in-process API suite and the standalone dev/E2E
// server both install a fake generator, so a suite controls the graph payload instead of running
// the analyzer. Both are no-ops in production. Never import from a feature module.

import { config } from '@core/env';

import { __set_workflow_generation_override } from './workflows.graph';
import type {
  GenerationResult,
  WorkflowGenerationFn,
  WorkflowGenerationInput,
} from './workflows.graph';

/** Route generation through `fn` instead of running the static analyzer (test suite only). */
export function set_workflow_generation_mock(fn: WorkflowGenerationFn): void {
  if (!config.isTest) return;
  __set_workflow_generation_override(fn);
}

/** Remove any installed generation mock, restoring the real static-analysis path. */
export function clear_workflow_generation_mock(): void {
  if (!config.isTest) return;
  __set_workflow_generation_override(null);
}

/** @internal The fixed graph the standalone dev/E2E server returns, exported to keep it testable. */
export function build_stub_result(input: WorkflowGenerationInput): GenerationResult {
  const entry = input.source_path;
  const components = input.files
    .filter((file) => file.path !== entry && file.path.toLowerCase().endsWith('.py'))
    .map((file, index) => {
      const lower_path = file.path.toLowerCase();
      const kind =
        lower_path.includes('/tools/') || /(?:^|[._-])tool(?:[._-]|$)/.test(lower_path)
          ? ('tool' as const)
          : ('agent' as const);
      return {
        id: `component-${index}`,
        position: { x: index * 270, y: 210 },
        data: {
          kind,
          file: file.path,
          role: kind === 'tool' ? 'Called by the workflow' : 'Runs on the request path',
          tag: null,
          chips: [],
        },
      };
    });
  const workflow_x = components.length > 1 ? ((components.length - 1) * 270) / 2 : 0;
  const agent_count = components.filter((node) => node.data.kind === 'agent').length;
  const tool_count = components.length - agent_count;

  return {
    status: 'ready',
    design: {
      nodes: [
        {
          id: 'wf',
          position: { x: workflow_x, y: 0 },
          data: {
            kind: 'workflow',
            file: entry,
            role: 'Entry',
            tag: 'Entry',
            chips:
              components.length > 0
                ? [{ kind: 'components', label: `${components.length} components` }]
                : [],
          },
        },
        ...components,
      ],
      edges: components.map((node) => ({
        id: `wf__${node.id}`,
        source: 'wf',
        target: node.id,
        source_anchor: 'bottom',
        target_anchor: 'top',
        data: {
          edge_type: node.data.kind === 'tool' ? ('call' as const) : ('route' as const),
          label: node.data.kind === 'tool' ? 'call' : 'route',
        },
      })),
    },
    stats: {
      name: input.project_name,
      workflow_file: entry,
      summary: 'Deterministic test-mode workflow.',
      stats: [
        {
          id: 'components',
          label: 'Components',
          value: input.files.length,
          caption: 'agents + tools + workflow',
          accent: 'workflow',
        },
        {
          id: 'agents',
          label: 'Agents',
          value: agent_count,
          caption: 'orchestrate the flow',
          accent: 'agent',
        },
        {
          id: 'tools',
          label: 'Tools',
          value: tool_count,
          caption: 'callable functions',
          accent: 'tool',
        },
        {
          id: 'routes',
          label: 'Routes',
          value: components.length,
          caption: 'possible transitions',
          accent: 'route',
        },
        { id: 'loops', label: 'Loops', value: 0, caption: 'none', accent: 'loop' },
      ],
    },
  };
}

/**
 * Install the deterministic stub on a standalone server (server.ts) so uploads yield a fixed design
 * that suites can assert against. Opts in under NODE_ENV=test or WORKFLOW_GENERATION_STUB=true,
 * gated on !isProduction so a stray env var can never replace real generation in prod.
 */
export function install_test_workflow_generation(): void {
  const stub_via_env = !config.isProduction && config.workflows.generationStub;
  if (!config.isTest && !stub_via_env) return;
  __set_workflow_generation_override((input) => Promise.resolve(build_stub_result(input)));
}
