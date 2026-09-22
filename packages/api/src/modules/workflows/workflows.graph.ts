import { LOG_DOMAINS, logger } from '@core/logger';
import { record } from '@core/telemetry';

import { analyze_python_module, trace_return_modules } from './workflows.python';
import type { PythonModuleInfo } from './workflows.python';
import type {
  WorkflowComponentKind,
  WorkflowEdgeType,
  WorkflowFlowEdge,
  WorkflowFlowNode,
  WorkflowGeneratedDesignPayload,
  WorkflowGeneratedStatsPayload,
  WorkflowNodeChip,
} from './workflows.types';

/**
 * The one contract callers see. Generation NEVER throws: an unreadable source, a project with no
 * python, and an analyzer crash all resolve to `{ status: 'failed' }`, so the upload flow records a
 * FAILED row and moves on. The two states mirror the persisted workflow status the service writes.
 */
export type GenerationResult =
  | {
      readonly status: 'ready';
      readonly design: WorkflowGeneratedDesignPayload;
      readonly stats: WorkflowGeneratedStatsPayload;
    }
  | { readonly status: 'failed'; readonly error_message: string };

interface GraphNodeDraft {
  readonly id: string;
  readonly kind: WorkflowComponentKind;
  readonly file: string;
  readonly role: string;
  readonly tag: string | null;
  readonly calls: readonly string[];
}

type GraphStructure =
  | {
      readonly status: 'ready';
      readonly entry_id: string;
      readonly nodes: GraphNodeDraft[];
      readonly edges: WorkflowFlowEdge[];
    }
  | { readonly status: 'failed'; readonly error_message: string };

function slugify(stem: string): string {
  const slug = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug === '' ? 'component' : slug;
}

function pick_entry(
  modules: readonly PythonModuleInfo[],
  entry_path: string
): PythonModuleInfo | null {
  const by_path = modules.find((m) => m.path === entry_path);
  if (by_path) return by_path;
  // The claimed source_path can drift from the stored file list; fall back to naming convention.
  const candidates = modules.filter((m) => m.stem.toLowerCase().includes('workflow'));
  const exact = candidates.find((m) => m.stem.toLowerCase() === 'workflow');
  const suffixed = candidates.find((m) => m.stem.toLowerCase().endsWith('workflow'));
  return exact ?? suffixed ?? candidates[0] ?? null;
}

function build_resolver(
  modules: readonly PythonModuleInfo[]
): (ref: string) => PythonModuleInfo | null {
  const by_module_path = new Map(modules.map((m) => [m.module_path, m]));
  const by_stem = new Map<string, PythonModuleInfo[]>();
  for (const m of modules) {
    const list = by_stem.get(m.stem) ?? [];
    list.push(m);
    by_stem.set(m.stem, list);
  }
  return (ref) => {
    const exact = by_module_path.get(ref);
    if (exact) return exact;
    // Uploaded paths and import statements rarely share a common root, so a unique last segment
    // is accepted; an ambiguous one is dropped rather than guessed.
    const last = ref.split('.').at(-1) ?? ref;
    const candidates = by_stem.get(last);
    return candidates !== undefined && candidates.length === 1 ? (candidates[0] ?? null) : null;
  };
}

const ANCHOR_BY_EDGE_TYPE: Record<
  WorkflowEdgeType,
  Pick<WorkflowFlowEdge, 'source_anchor' | 'target_anchor'>
> = {
  route: { source_anchor: 'bottom', target_anchor: 'top' },
  call: { source_anchor: 'bottom', target_anchor: 'top' },
  loop: { source_anchor: 'right', target_anchor: 'right' },
  return: { source_anchor: 'left', target_anchor: 'left' },
};

/** @internal Exported so the structural rules stay unit-testable without the full pipeline. */
export async function build_graph_structure(
  modules: readonly PythonModuleInfo[],
  entry_path: string
): Promise<GraphStructure> {
  const sorted = [...modules].sort((a, b) => a.path.localeCompare(b.path));
  const entry = pick_entry(sorted, entry_path);
  if (!entry) return { status: 'failed', error_message: 'no workflow entry file found' };

  const resolve = build_resolver(sorted);

  const id_by_path = new Map<string, string>();
  const used_ids = new Map<string, number>();
  const claim_id = (base: string): string => {
    const count = (used_ids.get(base) ?? 0) + 1;
    used_ids.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  };
  // The entry claims "workflow" first so another file literally named workflow.py gets suffixed.
  id_by_path.set(entry.path, claim_id('workflow'));
  for (const m of sorted) {
    if (m.path !== entry.path) id_by_path.set(m.path, claim_id(slugify(m.stem)));
  }
  const id_of = (path: string): string => id_by_path.get(path) ?? path;
  const entry_id = id_of(entry.path);

  const nodes: GraphNodeDraft[] = sorted.map((m) => {
    const calls = [
      ...new Set(
        m.imports
          .map(resolve)
          .filter((target): target is PythonModuleInfo => target !== null && target.path !== m.path)
          .map((target) => id_of(target.path))
      ),
    ].sort();
    const is_entry = m.path === entry.path;
    // v1 heuristic, acknowledged: any resolved local import promotes a file to `agent`, so a tool
    // importing a shared helper reads as an agent and the helper becomes a tool node. Decorator /
    // base-class / *.agent.py signals are the upgrade path if this misreads real projects.
    const kind: WorkflowComponentKind = is_entry ? 'workflow' : calls.length > 0 ? 'agent' : 'tool';
    // v1 role, acknowledged: the docstring's first line (or nothing) — deterministic, but with no
    // semantic understanding of what the component does.
    const role = m.docstring ?? (is_entry ? 'Entry — receives the request' : '');
    return { id: id_of(m.path), kind, file: m.path, role, tag: is_entry ? 'Entry' : null, calls };
  });
  const node_by_id = new Map(nodes.map((n) => [n.id, n]));

  const edges: WorkflowFlowEdge[] = [];
  const pair_counts = new Map<string, number>();
  const push_edge = (source: string, target: string, edge_type: WorkflowEdgeType): void => {
    const pair = `${source}__${target}`;
    const count = (pair_counts.get(pair) ?? 0) + 1;
    pair_counts.set(pair, count);
    edges.push({
      id: count === 1 ? pair : `${pair}__${count}`,
      source,
      target,
      ...ANCHOR_BY_EDGE_TYPE[edge_type],
      data: { edge_type, label: null },
    });
  };

  // DFS with an on-stack set: an edge to a node still on the current path is a back-edge (loop).
  const visited = new Set<string>();
  const on_stack = new Set<string>();
  const visit = (node: GraphNodeDraft): void => {
    visited.add(node.id);
    on_stack.add(node.id);
    for (const target_id of node.calls) {
      const target = node_by_id.get(target_id);
      if (!target) continue;
      if (on_stack.has(target_id)) push_edge(node.id, target_id, 'loop');
      else push_edge(node.id, target_id, target.kind === 'tool' ? 'call' : 'route');
      if (!visited.has(target_id)) visit(target);
    }
    on_stack.delete(node.id);
  };
  const entry_node = node_by_id.get(entry_id);
  if (entry_node) visit(entry_node);
  for (const node of nodes) {
    if (!visited.has(node.id)) visit(node);
  }

  const return_refs = await trace_return_modules(entry.content, entry.class_imports);
  for (const ref of return_refs) {
    const target = resolve(ref);
    if (!target || target.path === entry.path) continue;
    push_edge(id_of(target.path), entry_id, 'return');
  }

  return { status: 'ready', entry_id, nodes, edges };
}

const graph_logger = logger.child({ domain: LOG_DOMAINS.HTTP });

interface WorkflowGenerationFile {
  readonly path: string;
  readonly content: string;
}

export interface WorkflowGenerationInput {
  readonly project_name: string;
  readonly source_path: string;
  readonly files: readonly WorkflowGenerationFile[];
}

export type WorkflowGenerationFn = (input: WorkflowGenerationInput) => Promise<GenerationResult>;

/** Persisted as the workflow's generation model label. */
export const GENERATION_ENGINE = 'static-ast/v1';

// Layered top-down canvas centered on x=400 — the layout the workflow canvas renders against.
// Every card renders at one width (`nodeWidthToken`, 14rem), so a shared x is a shared centre and
// the spacing below is a true gap between cards rather than a per-kind approximation.
//
// Both gaps are per-step, not a table of absolute coordinates: a graph is as deep and as wide as it
// is, and a fixed set of rows would have to put everything past the last one somewhere it does not
// belong.
const CENTER_X = 400;
const ROW_SPACING = 250;
const COLUMN_SPACING = 270;

function pluralize(count: number, word: string): string {
  return count === 1 ? `${count} ${word}` : `${count} ${word}s`;
}

function compute_positions(
  nodes: readonly GraphNodeDraft[],
  edges: readonly WorkflowFlowEdge[],
  entry_id: string
): Map<string, { x: number; y: number }> {
  // Depth follows forward flow only, so loop/return edges don't drag a node back up the canvas.
  const children = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.data.edge_type !== 'route' && edge.data.edge_type !== 'call') continue;
    const list = children.get(edge.source) ?? [];
    list.push(edge.target);
    children.set(edge.source, list);
  }

  const depth = new Map<string, number>([[entry_id, 0]]);
  const queue = [entry_id];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const child of children.get(current) ?? []) {
      if (!depth.has(child)) {
        depth.set(child, (depth.get(current) ?? 0) + 1);
        queue.push(child);
      }
    }
  }

  // Nodes never reached from the entry (disconnected files) still need a position; park them one
  // layer past the deepest reached one.
  const fallback_depth = Math.max(0, ...depth.values()) + 1;
  for (const node of nodes) {
    if (!depth.has(node.id)) depth.set(node.id, fallback_depth);
  }

  const layers = new Map<number, string[]>();
  for (const [id, d] of depth) {
    const layer = layers.get(d) ?? [];
    layer.push(id);
    layers.set(d, layer);
  }

  const callers = new Map<string, string[]>();
  for (const [source, targets] of children) {
    for (const target of targets) {
      const list = callers.get(target) ?? [];
      list.push(source);
      callers.set(target, list);
    }
  }
  const positions = new Map<string, { x: number; y: number }>();
  // Ascending depth: a lone node reads its callers' positions, which the layer above just set.
  for (const d of [...layers.keys()].sort((a, b) => a - b)) {
    const members = layers.get(d) ?? [];
    const y = d * ROW_SPACING;

    // A row of one has no siblings to make room for, so it drops straight out of whatever called
    // it and the smooth-step edge becomes a plain vertical line. A row of many stays evenly spread
    // on the canvas centre — a fan reads better than a set of stacked columns.
    const only = members.length === 1 ? members[0] : undefined;
    if (only !== undefined) {
      const anchors = (callers.get(only) ?? [])
        .map((caller) => positions.get(caller)?.x)
        .filter((x): x is number => x !== undefined);
      const x =
        anchors.length > 0
          ? anchors.reduce((sum, value) => sum + value, 0) / anchors.length
          : CENTER_X;
      positions.set(only, { x, y });
      continue;
    }

    const start_x = CENTER_X - ((members.length - 1) * COLUMN_SPACING) / 2;
    members.forEach((id, index) => positions.set(id, { x: start_x + index * COLUMN_SPACING, y }));
  }
  return positions;
}

function chips_for(
  node: GraphNodeDraft,
  edges: readonly WorkflowFlowEdge[],
  total_nodes: number
): WorkflowNodeChip[] {
  if (node.kind === 'workflow') {
    return [{ kind: 'components', label: pluralize(total_nodes, 'component') }];
  }
  if (node.kind === 'tool') return [];
  const tool_calls = edges.filter(
    (e) => e.source === node.id && e.data.edge_type === 'call'
  ).length;
  const routes = edges.filter((e) => e.source === node.id && e.data.edge_type === 'route').length;
  const chips: WorkflowNodeChip[] = [];
  if (tool_calls > 0) chips.push({ kind: 'tools', label: pluralize(tool_calls, 'tool') });
  if (routes > 0) chips.push({ kind: 'routes', label: pluralize(routes, 'route') });
  return chips;
}

function build_stats(
  project_name: string,
  entry_file: string,
  nodes: readonly GraphNodeDraft[],
  edges: readonly WorkflowFlowEdge[]
): WorkflowGeneratedStatsPayload {
  const agents = nodes.filter((n) => n.kind === 'agent').length;
  const tools = nodes.filter((n) => n.kind === 'tool').length;
  const routes = edges.filter((e) => e.data.edge_type === 'route').length;
  const loops = edges.filter((e) => e.data.edge_type === 'loop').length;
  return {
    name: project_name,
    workflow_file: entry_file,
    summary:
      `${pluralize(agents, 'agent')}, ${pluralize(tools, 'tool')} — ` +
      `${pluralize(routes, 'routed connection')}, ${pluralize(loops, 'loop')}.`,
    stats: [
      {
        id: 'components',
        label: 'Components',
        value: nodes.length,
        caption: 'agents + tools + workflow',
        accent: 'workflow',
      },
      {
        id: 'agents',
        label: 'Agents',
        value: agents,
        caption: 'orchestrate the flow',
        accent: 'agent',
      },
      { id: 'tools', label: 'Tools', value: tools, caption: 'callable functions', accent: 'tool' },
      {
        id: 'routes',
        label: 'Routes',
        value: routes,
        caption: 'possible transitions',
        accent: 'route',
      },
      {
        id: 'loops',
        label: 'Loops',
        value: loops,
        caption: loops > 0 ? 'feedback paths' : 'none',
        accent: 'loop',
      },
    ],
  };
}

async function run_static_generation(input: WorkflowGenerationInput): Promise<GenerationResult> {
  try {
    const python_files = [...input.files]
      .filter((file) => file.path.toLowerCase().endsWith('.py'))
      .sort((a, b) => a.path.localeCompare(b.path));
    if (python_files.length === 0) {
      return { status: 'failed', error_message: 'no python source files to analyze' };
    }

    const modules: PythonModuleInfo[] = [];
    for (const file of python_files) {
      modules.push(await analyze_python_module(file.path, file.content));
    }

    const structure = await build_graph_structure(modules, input.source_path);
    if (structure.status === 'failed') return structure;

    const positions = compute_positions(structure.nodes, structure.edges, structure.entry_id);
    const nodes: WorkflowFlowNode[] = structure.nodes.map((node) => ({
      id: node.id,
      position: positions.get(node.id) ?? { x: CENTER_X, y: 0 },
      data: {
        kind: node.kind,
        file: node.file,
        role: node.role,
        tag: node.tag,
        chips: chips_for(node, structure.edges, structure.nodes.length),
      },
    }));

    const entry = structure.nodes.find((n) => n.id === structure.entry_id);
    return {
      status: 'ready',
      design: { nodes, edges: structure.edges },
      stats: build_stats(
        input.project_name,
        entry?.file ?? input.source_path,
        structure.nodes,
        structure.edges
      ),
    };
  } catch (error) {
    graph_logger.error('static workflow generation crashed', { error });
    return { status: 'failed', error_message: 'static analysis failed unexpectedly' };
  }
}

// The override lets the testkit stub generation. Gating (test-only / dev-stub) lives in the
// testkit; this is just the raw hook. See workflows.generation.testkit.ts.
let generation_override: WorkflowGenerationFn | null = null;

/** @internal Replace the generator for the testkit without changing the production call path. */
export function __set_workflow_generation_override(fn: WorkflowGenerationFn | null): void {
  generation_override = fn;
}

/**
 * Generate a workflow design + stats from a project's source files by static analysis. Resolves
 * to a `GenerationResult`; never throws. A registered override (see the testkit) short-circuits it.
 */
export function generate_workflow_from_files(
  input: WorkflowGenerationInput
): Promise<GenerationResult> {
  if (generation_override) return generation_override(input);
  return Promise.resolve(
    record('workflows.generate', () => run_static_generation(input), {
      file_count: input.files.length,
    })
  );
}
