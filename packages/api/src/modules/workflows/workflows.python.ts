import Parser from 'web-tree-sitter';

type SyntaxNode = Parser.SyntaxNode;

// tree-sitter-wasms ships grammars built against the web-tree-sitter 0.20.x ABI — the runtime pin
// and this package move together (a newer runtime fails to load these wasm files).
const PYTHON_WASM = 'tree-sitter-wasms/out/tree-sitter-python.wasm';

let parser_promise: Promise<Parser> | null = null;
function get_parser(): Promise<Parser> {
  if (!parser_promise) {
    parser_promise = (async () => {
      await Parser.init();
      const language = await Parser.Language.load(Bun.resolveSync(PYTHON_WASM, import.meta.dir));
      const parser = new Parser();
      parser.setLanguage(language);
      return parser;
    })();
    // A failed init (e.g. missing wasm) must not poison later calls: the rejected promise is
    // dropped so the next call retries from scratch.
    parser_promise.catch(() => {
      parser_promise = null;
    });
  }
  return parser_promise;
}

export interface PythonModuleInfo {
  readonly path: string;
  readonly stem: string;
  readonly module_path: string;
  readonly docstring: string | null;
  readonly imports: readonly string[];
  readonly class_imports: ReadonlyMap<string, string>;
  readonly content: string;
}

function stem_of(path: string): string {
  const base = path.split('/').at(-1) ?? path;
  return base.replace(/\.py$/i, '');
}

function module_ref(node: SyntaxNode): string {
  return node.text.replace(/^\.+/, '');
}

function extract_docstring(root: SyntaxNode): string | null {
  const first = root.namedChild(0);
  if (first?.type !== 'expression_statement') return null;
  const str = first.namedChild(0);
  if (str?.type !== 'string') return null;
  const content =
    str.namedChildren.find((child) => child.type === 'string_content')?.text ??
    str.text.replace(/^[rubf]*['"]+/i, '').replace(/['"]+$/, '');
  const line = content.trim().split('\n')[0];
  return line && line.trim() !== '' ? line.trim() : null;
}

export async function analyze_python_module(
  path: string,
  content: string
): Promise<PythonModuleInfo> {
  const parser = await get_parser();
  const tree = parser.parse(content);
  try {
    const imports = new Set<string>();
    const class_imports = new Map<string, string>();

    for (const stmt of tree.rootNode.descendantsOfType('import_from_statement')) {
      const module_node = stmt.childForFieldName('module_name');
      if (!module_node) continue;
      const mod = module_ref(module_node);
      // Compare by position: web-tree-sitter hands out fresh node wrappers, so `!==` on the
      // objects would not exclude the module node from the name list.
      const names = stmt.namedChildren.filter(
        (child) => child.startIndex !== module_node.startIndex && child.type !== 'comment'
      );
      if (mod === '') {
        // `from . import router` — the imported names are themselves local modules
        for (const name of names) imports.add(module_ref(name));
        continue;
      }
      imports.add(mod);
      for (const name of names) {
        const local =
          name.type === 'aliased_import' ? name.childForFieldName('alias')?.text : name.text;
        if (local && local !== '*') class_imports.set(local, mod);
      }
    }

    for (const stmt of tree.rootNode.descendantsOfType('import_statement')) {
      for (const name of stmt.namedChildren) {
        const target = name.type === 'aliased_import' ? name.childForFieldName('name') : name;
        if (target) imports.add(module_ref(target));
      }
    }

    return {
      path,
      stem: stem_of(path),
      module_path: path.replace(/\.py$/i, '').replaceAll('/', '.'),
      docstring: extract_docstring(tree.rootNode),
      imports: [...imports].sort(),
      class_imports,
      content,
    };
  } finally {
    tree.delete();
  }
}

/**
 * Resolve which imported modules produce the value a file returns. Only positions that are
 * structurally "the returned value itself" are followed: a (possibly chained) method call's
 * receiver, a single-argument wrapper call, a name assigned from a traced value, and the direct
 * values of dict/list/tuple/set literals.
 */
export async function trace_return_modules(
  content: string,
  class_imports: ReadonlyMap<string, string>
): Promise<readonly string[]> {
  const parser = await get_parser();
  const tree = parser.parse(content);
  try {
    const var_to_module = new Map<string, string>();
    const result_to_module = new Map<string, string>();

    const trace = (expr: SyntaxNode): Set<string> => {
      if (expr.type === 'call') {
        const fn = expr.childForFieldName('function');
        if (fn?.type === 'attribute') {
          const receiver = fn.childForFieldName('object');
          if (receiver?.type === 'identifier') {
            const mod = var_to_module.get(receiver.text);
            return mod ? new Set([mod]) : new Set();
          }
          if (receiver?.type === 'call') return trace(receiver);
          return new Set();
        }
        if (fn?.type === 'identifier') {
          const args = expr.childForFieldName('arguments');
          const positional = args?.namedChildren.filter((arg) => arg.type !== 'comment') ?? [];
          // A single-argument wrapper (`str(x)`) is transparent; a multi-argument call is not — a
          // variable used as one input among several is not what the workflow returns.
          const only = positional.length === 1 ? positional[0] : undefined;
          if (only && only.type !== 'keyword_argument') return trace(only);
        }
        return new Set();
      }
      if (expr.type === 'identifier') {
        const mod = var_to_module.get(expr.text) ?? result_to_module.get(expr.text);
        return mod ? new Set([mod]) : new Set();
      }
      if (expr.type === 'dictionary') {
        const out = new Set<string>();
        for (const pair of expr.namedChildren) {
          const value = pair.type === 'pair' ? pair.childForFieldName('value') : null;
          if (value) for (const mod of trace(value)) out.add(mod);
        }
        return out;
      }
      if (['list', 'tuple', 'set', 'expression_list'].includes(expr.type)) {
        const out = new Set<string>();
        for (const element of expr.namedChildren) for (const mod of trace(element)) out.add(mod);
        return out;
      }
      return new Set();
    };

    // Source order matters: a later assignment may reference an earlier traced result.
    // descendantsOfType returns nodes in document order.
    for (const assign of tree.rootNode.descendantsOfType('assignment')) {
      const left = assign.childForFieldName('left');
      const right = assign.childForFieldName('right');
      if (left?.type !== 'identifier' || !right) continue;
      if (right.type === 'call') {
        const fn = right.childForFieldName('function');
        if (fn?.type === 'identifier') {
          const mod = class_imports.get(fn.text);
          if (mod) {
            var_to_module.set(left.text, mod);
            continue;
          }
        }
      }
      const traced = trace(right);
      if (traced.size === 1) {
        const [mod] = traced;
        if (mod) result_to_module.set(left.text, mod);
      }
    }

    const sources = new Set<string>();
    for (const ret of tree.rootNode.descendantsOfType('return_statement')) {
      const value = ret.namedChild(0);
      if (value) for (const mod of trace(value)) sources.add(mod);
    }
    return [...sources].sort();
  } finally {
    tree.delete();
  }
}
