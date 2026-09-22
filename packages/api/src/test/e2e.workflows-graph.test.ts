import { describe, expect, test } from 'bun:test';

import {
  __set_workflow_generation_override,
  build_graph_structure,
  generate_workflow_from_files,
} from '../modules/workflows/workflows.graph';
import { analyze_python_module, trace_return_modules } from '../modules/workflows/workflows.python';
import type { PythonModuleInfo } from '../modules/workflows/workflows.python';

const SAMPLE_FILES = [
  {
    path: 'research_workflow.py',
    content: [
      'from router import Router',
      'from responder import Responder',
      'router = Router()',
      'responder = Responder()',
      'def handle(request):',
      '    route = router.classify(request)',
      '    answer = responder.reply(route)',
      '    return answer',
    ].join('\n'),
  },
  {
    path: 'router.py',
    content: [
      '"""Classifies intent and routes the request."""',
      'from intent import Intent',
      'from responder import Responder',
      'class Router:',
      '    def classify(self, request):',
      '        return Intent().detect(request)',
    ].join('\n'),
  },
  {
    path: 'intent.py',
    content: [
      'from customer_lookup import lookup',
      'class Intent:',
      '    def detect(self, request):',
      '        return lookup(request)',
    ].join('\n'),
  },
  {
    path: 'responder.py',
    content: [
      'from search import search',
      'import router',
      'class Responder:',
      '    def reply(self, route):',
      '        return search(route)',
    ].join('\n'),
  },
  {
    path: 'customer_lookup.py',
    content: 'def lookup(request):\n    return {"customer": request}\n',
  },
  { path: 'search.py', content: 'def search(q):\n    return q\n' },
];

async function analyze_sample(): Promise<PythonModuleInfo[]> {
  return Promise.all(SAMPLE_FILES.map((f) => analyze_python_module(f.path, f.content)));
}

describe('analyze_python_module', () => {
  test('extracts plain, aliased, subpackage, and relative imports', async () => {
    const info = await analyze_python_module(
      'responder.py',
      [
        'from agents.router import Router',
        'from search import run as run_search',
        'from . import helper',
        'from .intent import Intent',
        'import customer_lookup as db',
        'import os',
      ].join('\n')
    );
    expect(info.imports).toEqual([
      'agents.router',
      'customer_lookup',
      'helper',
      'intent',
      'os',
      'search',
    ]);
    expect(info.class_imports.get('Router')).toBe('agents.router');
    expect(info.class_imports.get('run_search')).toBe('search');
    expect(info.class_imports.get('Intent')).toBe('intent');
  });

  test('derives stem, module_path, and first docstring line', async () => {
    const info = await analyze_python_module(
      'agents/router.py',
      '"""Routes the request.\nMore detail."""\nx = 1\n'
    );
    expect(info.stem).toBe('router');
    expect(info.module_path).toBe('agents.router');
    expect(info.docstring).toBe('Routes the request.');
  });

  test('returns null docstring when the file has none', async () => {
    const info = await analyze_python_module('t.py', 'x = 1\n');
    expect(info.docstring).toBeNull();
  });

  test('tolerates syntax errors without throwing', async () => {
    const info = await analyze_python_module(
      'broken.py',
      'from search import run\ndef f(:\n  return'
    );
    expect(info.imports).toEqual(['search']);
  });
});

describe('trace_return_modules', () => {
  const CLASS_IMPORTS = new Map([
    ['Router', 'router'],
    ['Responder', 'responder'],
    ['RiskAgent', 'risk_agent'],
  ]);

  test('traces a returned variable back through assignments to its module', async () => {
    const refs = await trace_return_modules(
      [
        'from router import Router',
        'from responder import Responder',
        'router = Router()',
        'responder = Responder()',
        'def handle(request):',
        '    route = router.classify(request)',
        '    answer = responder.reply(route)',
        '    return answer',
      ].join('\n'),
      CLASS_IMPORTS
    );
    expect(refs).toEqual(['responder']);
  });

  test('does not treat a multi-arg call argument as a return source', async () => {
    const refs = await trace_return_modules(
      [
        'from router import Router',
        'from responder import Responder',
        'router = Router()',
        'responder = Responder()',
        'def handle(request):',
        '    answer = router.classify(request)',
        '    return responder.reply(request, answer)',
      ].join('\n'),
      CLASS_IMPORTS
    );
    expect(refs).toEqual(['responder']);
  });

  test('follows chained calls, single-arg wrappers, and dict values', async () => {
    const refs = await trace_return_modules(
      [
        'from risk_agent import RiskAgent',
        'from responder import Responder',
        'risk = RiskAgent()',
        'responder = Responder()',
        'def handle(request):',
        '    score = risk.assess(request).value()',
        '    return {"score": score, "text": str(responder.reply(request))}',
      ].join('\n'),
      CLASS_IMPORTS
    );
    expect(refs).toEqual(['responder', 'risk_agent']);
  });
});

describe('build_graph_structure', () => {
  test('classifies workflow/agent/tool and builds deterministic edges', async () => {
    const structure = await build_graph_structure(await analyze_sample(), 'research_workflow.py');
    expect(structure.status).toBe('ready');
    if (structure.status !== 'ready') return;

    const kinds = Object.fromEntries(structure.nodes.map((n) => [n.id, n.kind]));
    expect(kinds).toEqual({
      workflow: 'workflow',
      router: 'agent',
      responder: 'agent',
      intent: 'agent',
      customer_lookup: 'tool',
      search: 'tool',
    });

    expect(structure.edges.map((e) => [e.id, e.data.edge_type])).toEqual([
      ['workflow__responder', 'route'],
      ['responder__router', 'route'],
      ['router__intent', 'route'],
      ['intent__customer_lookup', 'call'],
      ['router__responder', 'loop'],
      ['responder__search', 'call'],
      ['workflow__router', 'route'],
      ['responder__workflow', 'return'],
    ]);
  });

  test('anchors: route/call flow down, loops curve right, returns run left', async () => {
    const structure = await build_graph_structure(await analyze_sample(), 'research_workflow.py');
    if (structure.status !== 'ready') throw new Error('expected ready structure');
    const by_id = new Map(structure.edges.map((e) => [e.id, e]));
    expect(by_id.get('workflow__responder')).toMatchObject({
      source_anchor: 'bottom',
      target_anchor: 'top',
    });
    expect(by_id.get('router__responder')).toMatchObject({
      source_anchor: 'right',
      target_anchor: 'right',
    });
    expect(by_id.get('responder__workflow')).toMatchObject({
      source_anchor: 'left',
      target_anchor: 'left',
    });
  });

  test('suffixes duplicate edge pairs and duplicate stems', async () => {
    const modules = await Promise.all(
      [
        // responder both routes back to the workflow module and is its return source, so the
        // responder__workflow pair occurs twice and needs a __2 suffix
        {
          path: 'main_workflow.py',
          content: [
            'from responder import Responder',
            'responder = Responder()',
            'def handle(r):',
            '    return responder.reply(r)',
          ].join('\n'),
        },
        { path: 'responder.py', content: 'import main_workflow\nfrom a.util import x\n' },
        { path: 'a/util.py', content: 'x = 1\n' },
        { path: 'b/util.py', content: 'y = 1\n' },
      ].map((f) => analyze_python_module(f.path, f.content))
    );
    const structure = await build_graph_structure(modules, 'main_workflow.py');
    if (structure.status !== 'ready') throw new Error('expected ready structure');

    const ids = structure.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['responder', 'util', 'util_2', 'workflow']);
    const edge_ids = structure.edges.map((e) => e.id);
    expect(edge_ids).toContain('responder__workflow');
    expect(edge_ids).toContain('responder__workflow__2');
  });

  test('fails cleanly when no entry file can be found', async () => {
    const modules = await Promise.all(
      [{ path: 'lonely_tool.py', content: 'x = 1\n' }].map((f) =>
        analyze_python_module(f.path, f.content)
      )
    );
    const structure = await build_graph_structure(modules, 'missing.py');
    expect(structure).toEqual({ status: 'failed', error_message: 'no workflow entry file found' });
  });
});

describe('generate_workflow_from_files (static)', () => {
  const INPUT = {
    project_name: 'Research Agent',
    source_path: 'research_workflow.py',
    files: SAMPLE_FILES,
  };

  test('produces a schema-valid design with layered layout, chips, and stats', async () => {
    const result = await generate_workflow_from_files(INPUT);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;

    // Referential integrity is the one design invariant the type system cannot state.
    const node_ids = new Set(result.design.nodes.map((n) => n.id));
    expect(node_ids.size).toBe(result.design.nodes.length);
    for (const edge of result.design.edges) {
      expect(node_ids.has(edge.source)).toBe(true);
      expect(node_ids.has(edge.target)).toBe(true);
    }

    const by_id = new Map(result.design.nodes.map((n) => [n.id, n]));
    expect(by_id.get('workflow')?.position).toEqual({ x: 400, y: 0 });
    expect(by_id.get('responder')?.position.y).toBe(250);
    expect(by_id.get('router')?.position.y).toBe(250);
    expect(by_id.get('customer_lookup')?.position.y).toBe(750);

    expect(by_id.get('workflow')?.data.chips).toEqual([
      { kind: 'components', label: '6 components' },
    ]);
    expect(by_id.get('responder')?.data.chips).toEqual([
      { kind: 'tools', label: '1 tool' },
      { kind: 'routes', label: '1 route' },
    ]);
    expect(by_id.get('router')?.data.role).toBe('Classifies intent and routes the request.');

    expect(result.stats.name).toBe('Research Agent');
    expect(result.stats.workflow_file).toBe('research_workflow.py');
    expect(result.stats.summary).toBe('3 agents, 2 tools — 4 routed connections, 1 loop.');
    expect(result.stats.stats.map((s) => [s.id, s.value])).toEqual([
      ['components', 6],
      ['agents', 3],
      ['tools', 2],
      ['routes', 4],
      ['loops', 1],
    ]);
  });

  test('is deterministic across runs and input file order', async () => {
    const first = await generate_workflow_from_files(INPUT);
    const second = await generate_workflow_from_files({
      ...INPUT,
      files: [...INPUT.files].reverse(),
    });
    expect(second).toEqual(first);
  });

  test('fails cleanly on a project with no python files', async () => {
    const result = await generate_workflow_from_files({
      project_name: 'Docs',
      source_path: 'README.md',
      files: [{ path: 'README.md', content: '# hi' }],
    });
    expect(result).toEqual({
      status: 'failed',
      error_message: 'no python source files to analyze',
    });
  });

  test('honors the generation override hook', async () => {
    const stub = { status: 'failed' as const, error_message: 'stubbed' };
    __set_workflow_generation_override(() => Promise.resolve(stub));
    try {
      expect(await generate_workflow_from_files(INPUT)).toBe(stub);
    } finally {
      __set_workflow_generation_override(null);
    }
  });
});

describe('layout: lone rows drop straight, crowded rows fan out', () => {
  const FAN_THEN_ONE = [
    {
      path: 'portfolio_workflow.py',
      content: [
        'from agents.advisor_agent import AdvisorAgent',
        'from agents.intent_agent import IntentAgent',
        'from agents.metrics_agent import MetricsAgent',
        'from agents.risk_agent import RiskAgent',
        'advisor = AdvisorAgent()',
        'def handle(r):',
        '    return advisor.reply(r)',
      ].join('\n'),
    },
    { path: 'agents/advisor_agent.py', content: 'class AdvisorAgent:\n    pass\n' },
    { path: 'agents/intent_agent.py', content: 'class IntentAgent:\n    pass\n' },
    {
      path: 'agents/metrics_agent.py',
      content: 'from agents.price_agent import price\nclass MetricsAgent:\n    pass\n',
    },
    { path: 'agents/risk_agent.py', content: 'class RiskAgent:\n    pass\n' },
    { path: 'agents/price_agent.py', content: 'def price(x):\n    return x\n' },
  ];

  // Every card renders at one width, so an equal x is an equal centre: the edge comes out vertical.
  test('a row of one sits directly under its caller', async () => {
    const result = await generate_workflow_from_files({
      project_name: 'Portfolio',
      source_path: 'portfolio_workflow.py',
      files: FAN_THEN_ONE,
    });
    if (result.status !== 'ready') throw new Error('expected ready result');
    const by_id = new Map(result.design.nodes.map((node) => [node.id, node]));

    const caller = by_id.get('metrics_agent');
    const lone = by_id.get('price_agent');
    expect(lone?.position.y).toBe(500);
    expect(lone?.position.x).toBe(caller?.position.x);
  });

  // A chain deeper than any fixed set of rows: every extra step gets its own row rather than
  // piling onto the last one.
  test('keeps giving deeper layers their own row', async () => {
    const chain = [
      { path: 'workflow.py', content: 'from a import A\nx = A()\n' },
      { path: 'a.py', content: 'from b import B\nx = B()\n' },
      { path: 'b.py', content: 'from c import C\nx = C()\n' },
      { path: 'c.py', content: 'from d import D\nx = D()\n' },
      { path: 'd.py', content: 'from e import E\nx = E()\n' },
      { path: 'e.py', content: 'y = 1\n' },
    ];
    const result = await generate_workflow_from_files({
      project_name: 'Deep Chain',
      source_path: 'workflow.py',
      files: chain,
    });
    if (result.status !== 'ready') throw new Error('expected ready result');

    const by_id = new Map(result.design.nodes.map((node) => [node.id, node]));
    expect(by_id.get('workflow')?.position.y).toBe(0);
    expect(by_id.get('a')?.position.y).toBe(250);
    expect(by_id.get('e')?.position.y).toBe(1250);

    const points = result.design.nodes.map(({ position }) => `${position.x},${position.y}`);
    expect(new Set(points).size).toBe(result.design.nodes.length);
  });

  test('a row of many still spreads across the canvas centre', async () => {
    const result = await generate_workflow_from_files({
      project_name: 'Portfolio',
      source_path: 'portfolio_workflow.py',
      files: FAN_THEN_ONE,
    });
    if (result.status !== 'ready') throw new Error('expected ready result');

    const row = result.design.nodes
      .filter((node) => node.position.y === 250)
      .map((node) => node.position.x)
      .sort((a, b) => a - b);
    expect(row).toEqual([-5, 265, 535, 805]);
  });
});
