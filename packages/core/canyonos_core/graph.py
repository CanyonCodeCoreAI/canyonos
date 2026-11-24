# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Which agents each agent of a workflow can call, read from its code without running
it. `put-workflow` (workspace_jobs.py) reads it from each upload, and the CanyonOS API
keeps it with the workflow and answers it at
`GET /v1/workflow-groups/<workflow_group_id>/workflows/<workflow_id>/graph`.

Why reading is enough: in every agent's image, `canyonos deploy` overwrites each
other agent's entrypoint with a generated stub of the same class name
(`canyonos_core.stub_generator`). So an agent reaches another only by importing
that agent's class from its entrypoint module, and every such import is in the
code. What reading can't tell is whether a call runs (a branch not taken), how
many times (a fan-out), or the order beyond one call taking another's result:
those are what a request's trace shows.

Pure standard library and the config's YAML: it never imports the workflow's code.
"""

import ast
import os

import yaml

from canyonos_core.schema import CONFIG_PATH

# The graph's shape; bump it when a field changes meaning, so a reader (the platform)
# can tell.
GRAPH_VERSION = 1
# Calls that load modules by name: what they reach only running the code can tell.
_DYNAMIC_IMPORTS = {"__import__", "import_module"}
# Calls with which agent code asks the person who sent the request and waits for the
# answer (controller/utils/human_input.py): `input()` is the builtin's own name.
_ASKING_CALLS = {"interrupt", "ask_human"}
# `try` statements: `try ... except*` is its own node from Python 3.11.
_TRY_STATEMENTS = (ast.Try, getattr(ast, "TryStar", ast.Try))


def _parse(path):
    """The module at `path`, or None when it can't be read or parsed."""
    try:
        with open(path, encoding="utf-8") as f:
            return ast.parse(f.read(), filename=path)
    except (OSError, SyntaxError, ValueError):
        return None


def _inside(root, path):
    """Whether `path` resolves to a file under `root`, symlinks followed."""
    real_root = os.path.realpath(root)
    try:
        return os.path.commonpath([real_root, os.path.realpath(path)]) == real_root
    except ValueError:
        return False


def _module_file(root, parts):
    """The workflow's file for a dotted module (`["agents", "review"]`), or None."""
    base = os.path.join(root, *parts)
    for candidate in (base + ".py", os.path.join(base, "__init__.py")):
        if os.path.isfile(candidate) and _inside(root, candidate):
            return os.path.realpath(candidate)
    return None


def _from_parts(root, path, node):
    """The dotted parts of the module an `ImportFrom` in `path` reads, relative
    imports resolved against the file's own package."""
    parts = []
    if node.level:
        package = os.path.dirname(os.path.relpath(path, os.path.realpath(root)))
        for _ in range(node.level - 1):
            package = os.path.dirname(package)
        parts = package.split(os.sep) if package else []
    return parts + (node.module.split(".") if node.module else [])


class _Agent:
    """One agent of the config: its name, the class its stub has, and its file."""

    def __init__(self, root, spec):
        self.name = spec["name"]
        self.class_name = self.name.rsplit(".", 1)[-1]
        self.entrypoint = spec.get("entrypoint")
        self.functions = [
            f["name"]
            for f in spec.get("functions") or []
            if isinstance(f, dict) and isinstance(f.get("name"), str)
        ]
        self.path = None
        if isinstance(self.entrypoint, str):
            path = os.path.join(root, os.path.normpath(self.entrypoint))
            if os.path.isfile(path) and _inside(root, path):
                self.path = os.path.realpath(path)


class _Reader:
    """Reads one agent's code, from its entrypoint through the workflow's own
    modules it imports, for the other agents it references and calls."""

    def __init__(self, root, agent, stubs):
        self.root = root
        self.agent = agent
        # In this agent's image, each other agent's file is that agent's stub.
        self.stubs = {path: a for path, a in stubs.items() if a is not agent}
        self.references = {}
        self.calls = []
        self.notes = []
        self.asks = []

    def read(self):
        """Every file reachable from the entrypoint, each once."""
        queue, seen = [self.agent.path], set()
        while queue:
            path = queue.pop()
            if path in seen or path in self.stubs:
                continue
            seen.add(path)
            tree = _parse(path)
            if tree is None:
                self._note(path, 1, "could not be parsed: its calls are left out")
                continue
            queue.extend(self._read_file(path, tree))
            self._read_asks(path, tree)
        return self

    def _read_asks(self, path, tree):
        """Records where this file asks a person: `input()` (unless the file defines its
        own), LangGraph's `interrupt()`, `ask_human()`, and a tool that needs approval
        (`needs_approval=` anything but False). Reading can't tell whether it runs."""
        defined = {
            node.name
            for node in ast.walk(tree)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
        }
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            name = (
                func.id
                if isinstance(func, ast.Name)
                else func.attr
                if isinstance(func, ast.Attribute)
                else None
            )
            via = None
            if name in _ASKING_CALLS:
                via = name
            elif (
                name == "input"
                and isinstance(func, ast.Name)
                and "input" not in defined
            ):
                via = "input"
            elif any(
                keyword.arg == "needs_approval"
                and not (
                    isinstance(keyword.value, ast.Constant)
                    and keyword.value.value is False
                )
                for keyword in node.keywords
            ):
                via = "approval"
            if via:
                self.asks.append(
                    {"via": via, "path": self._relative(path), "line": node.lineno}
                )

    def _note(self, path, line, text):
        self.notes.append({"path": self._relative(path), "line": line, "note": text})

    def _relative(self, path):
        return os.path.relpath(path, os.path.realpath(self.root)).replace(os.sep, "/")

    def _agent_named(self, path, name, seen=frozenset()):
        """The agent `name` is at module level in `path`: the stub's class itself,
        or a re-export of it (`from .review import ReviewAgent` in a package's
        `__init__.py`). None when it's anything else."""
        if (path, name) in seen:
            return None
        seen = seen | {(path, name)}
        stub = self.stubs.get(path)
        if stub is not None:
            return stub if name == stub.class_name else None
        tree = _parse(path)
        for node in tree.body if tree else []:
            if isinstance(node, ast.ImportFrom):
                for alias in node.names:
                    if (alias.asname or alias.name) == name:
                        found = self._imported(path, node, alias.name, seen)
                        if found is not None:
                            return found
            elif isinstance(node, ast.Assign) and isinstance(node.value, ast.Name):
                if any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
                    return self._agent_named(path, node.value.id, seen)
        return None

    def _imported(self, path, node, name, seen=frozenset()):
        """The agent `from <module> import <name>` in `path` binds, if any."""
        parts = _from_parts(self.root, path, node)
        module = _module_file(self.root, parts)
        return self._agent_named(module, name, seen) if module is not None else None

    def _read_file(self, path, tree):
        """Records this file's references and calls; returns the workflow files it
        imports, to read next."""
        # Local names bound to an agent's class, and to a module (as its dotted parts).
        classes, modules, next_files, libraries = {}, {}, [], set()
        # Names of the workflow's own functions and classes: their modules are
        # rewritten too, so a call to one passes an agent's result on unresolved.
        own = {
            node.name
            for node in ast.walk(tree)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
        }
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                parts = _from_parts(self.root, path, node)
                module = _module_file(self.root, parts)
                if module is not None:
                    own |= {alias.asname or alias.name for alias in node.names}
                else:
                    libraries |= {alias.asname or alias.name for alias in node.names}
                if module is not None and module not in self.stubs:
                    next_files.append(module)
                for alias in node.names:
                    local = alias.asname or alias.name
                    agent = self._imported(path, node, alias.name)
                    if agent is not None:
                        classes[local] = agent
                        continue
                    # `from agents import review_agent`: a module, read through
                    # its attributes.
                    submodule = _module_file(self.root, parts + [alias.name])
                    if submodule is not None:
                        modules[local] = parts + [alias.name]
                        if submodule not in self.stubs:
                            next_files.append(submodule)
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    parts = alias.name.split(".")
                    module = _module_file(self.root, parts)
                    if module is None:
                        libraries.add(alias.asname or parts[0])
                        continue
                    if module not in self.stubs:
                        next_files.append(module)
                    # `import agents.review` binds `agents`; the rest is read from
                    # the attribute chain.
                    if alias.asname:
                        modules[alias.asname] = parts
                    else:
                        modules.setdefault(parts[0], parts[:1])
            elif isinstance(node, ast.Call):
                callee = node.func
                name = (
                    callee.id
                    if isinstance(callee, ast.Name)
                    else callee.attr
                    if isinstance(callee, ast.Attribute)
                    else None
                )
                if name in _DYNAMIC_IMPORTS:
                    self._note(
                        path,
                        node.lineno,
                        "loads a module by name: an agent it reaches that way is left out",
                    )

        def class_of(expr):
            """The agent whose class `expr` names, or None."""
            if isinstance(expr, ast.Name):
                return classes.get(expr.id)
            if isinstance(expr, ast.Attribute):
                chain = []
                while isinstance(expr, ast.Attribute):
                    chain.insert(0, expr.attr)
                    expr = expr.value
                if not isinstance(expr, ast.Name) or expr.id not in modules:
                    return None
                # Everything but the last name is a module; the last, the class.
                module = _module_file(self.root, modules[expr.id] + chain[:-1])
                if module is not None:
                    return self._agent_named(module, chain[-1])
            return None

        # Names and `self.<name>` attributes set to an agent's object anywhere in
        # the file: read once, whatever the order, the way a reader would.
        objects = {}
        for node in ast.walk(tree):
            if isinstance(node, (ast.Assign, ast.AnnAssign)) and isinstance(
                node.value, ast.Call
            ):
                agent = class_of(node.value.func)
                if agent is None:
                    continue
                targets = (
                    node.targets if isinstance(node, ast.Assign) else [node.target]
                )
                for target in targets:
                    key = _object_key(target)
                    if key:
                        objects[key] = agent

        def callee_of(call):
            """`(agent, method)` when `call` calls a method on an agent's object."""
            func = call.func
            if not isinstance(func, ast.Attribute):
                return None
            owner = func.value
            agent = (
                class_of(owner.func)
                if isinstance(owner, ast.Call)
                else objects.get(_object_key(owner))
            )
            return (agent, func.attr) if agent is not None else None

        for node in ast.walk(tree):
            if isinstance(node, (ast.Name, ast.Attribute)):
                agent = class_of(node)
                if agent is not None:
                    self.references.setdefault(agent.name, agent)
        for function in ast.walk(tree):
            if isinstance(function, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self._read_calls(
                    path, function, callee_of, own | set(modules), libraries
                )
        return next_files

    def _read_calls(self, path, function, callee_of, own, libraries):
        """Each call in `function` to another agent, with the earlier calls it
        can't start before:

        - `waits_on`: those whose results it takes as an argument, as the Future
          itself or as anything made from it (`load(future.value())`, a field
          of that, a name set to it).
        - `after`: those whose results this function already used before making
          it, so it runs after them even when it takes none of their results.
          CanyonOS waits for a result at the first line that uses it (an index,
          an attribute such as `.value()`, an operator or comparison, an `if`,
          `for` or f-string, a library call), and passes it on unresolved to an
          agent or the workflow's own functions (RUNTIME_CONTRACT.md). Read in
          source order: a use in a branch not taken counts as waited on."""
        # The calls whose results each name (or `self.<name>`) holds, the call
        # each agent call node is, and the calls waited on so far.
        results, call_ids, waited = {}, {}, set()
        conditional = _conditional_nodes(function)

        def results_in(expr):
            """The calls whose results `expr` holds or is made from. An agent
            call's result is that call alone: what it took is its own `waits_on`."""
            found, stack = set(), [expr]
            while stack:
                n = stack.pop()
                if id(n) in call_ids:
                    found.add(call_ids[id(n)])
                    continue
                key = (
                    _object_key(n) if isinstance(n, (ast.Name, ast.Attribute)) else None
                )
                if key in results:
                    found |= results[key]
                stack.extend(ast.iter_child_nodes(n))
            return found

        def holding(expr):
            """The calls whose results `expr` is itself: an agent call, or a
            name holding results. Not what it's built from."""
            if id(expr) in call_ids:
                return {call_ids[id(expr)]}
            key = (
                _object_key(expr)
                if isinstance(expr, (ast.Name, ast.Attribute))
                else None
            )
            return results.get(key, set())

        for node in _in_order(function):
            # A line that uses a result waits for it.
            if isinstance(node, (ast.Subscript, ast.Attribute, ast.Starred)):
                waited |= holding(node.value)
            elif isinstance(node, (ast.BinOp,)):
                waited |= holding(node.left) | holding(node.right)
            elif isinstance(node, (ast.UnaryOp,)):
                waited |= holding(node.operand)
            elif isinstance(node, ast.BoolOp):
                for value in node.values:
                    waited |= holding(value)
            elif isinstance(node, ast.Compare):
                for operand in [node.left, *node.comparators]:
                    waited |= holding(operand)
            elif isinstance(node, (ast.If, ast.While, ast.IfExp, ast.Assert)):
                waited |= holding(node.test)
            elif isinstance(node, (ast.For, ast.AsyncFor, ast.comprehension)):
                waited |= holding(node.iter)
            elif isinstance(node, (ast.FormattedValue, ast.Await)):
                waited |= holding(node.value)
            if isinstance(node, ast.Call):
                callee = callee_of(node)
                if callee is None:
                    # A library call (`print(x)`, `json.dumps(x)`) gets the results,
                    # inside its arguments too. The workflow's own functions, and a
                    # method on an object (`results.append(x)`), get them unresolved.
                    func = node.func
                    root = func
                    while isinstance(root, ast.Attribute):
                        root = root.value
                    library = (isinstance(func, ast.Name) and func.id not in own) or (
                        isinstance(func, ast.Attribute)
                        and isinstance(root, ast.Name)
                        and root.id in libraries
                    )
                    if library:
                        for argument in [*node.args, *(k.value for k in node.keywords)]:
                            waited |= results_in(argument)
                    continue
                agent, method = callee
                call_id = f"{self.agent.name}:{self._relative(path)}:{node.lineno}:{node.col_offset}"
                takes = set()
                for argument in [*node.args, *(k.value for k in node.keywords)]:
                    takes |= results_in(argument)
                self.calls.append(
                    {
                        "id": call_id,
                        "source": self.agent.name,
                        "target": agent.name,
                        "method": method,
                        "declared": method in agent.functions,
                        "path": self._relative(path),
                        "line": node.lineno,
                        "waits_on": sorted(takes),
                        "after": sorted(waited - takes),
                        "conditional": id(node) in conditional,
                    }
                )
                call_ids[id(node)] = call_id
            elif isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
                if node.value is None:
                    continue
                held = results_in(node.value)
                targets = (
                    node.targets if isinstance(node, ast.Assign) else [node.target]
                )
                for target in targets:
                    # `a, b = ...` binds each name to what the value is made from.
                    names = (
                        target.elts
                        if isinstance(target, (ast.Tuple, ast.List))
                        else [target]
                    )
                    for name in names:
                        key = _object_key(name)
                        if key is None:
                            continue
                        if isinstance(node, ast.AugAssign):
                            held = held | results.get(key, set())
                        # A name set to something else no longer holds a result.
                        if held:
                            results[key] = held
                        else:
                            results.pop(key, None)


def _object_key(target):
    """`x` for a name, `self.x` for an attribute of a name, else None."""
    if isinstance(target, ast.Name):
        return target.id
    if isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name):
        return f"{target.value.id}.{target.attr}"
    return None


def _conditional_nodes(function):
    """The ids of the nodes in `function`'s own body that run only on some paths: the
    branches of an `if`, a conditional expression or a `match`, a loop's body and
    `else`, an `except` handler or a `try`'s `else`, the operands of `and`/`or` after
    the first, and a comprehension's elements. Functions defined inside it are read on
    their own."""
    found = set()

    def mark(nodes):
        for node in nodes:
            for n in _post_order(node):
                found.add(id(n))

    for node in _in_order(function):
        if isinstance(node, ast.If):
            mark(node.body + node.orelse)
        elif isinstance(node, ast.IfExp):
            mark([node.body, node.orelse])
        elif isinstance(node, (ast.For, ast.AsyncFor, ast.While)):
            mark(node.body + node.orelse)
        elif isinstance(node, _TRY_STATEMENTS):
            mark(node.orelse + node.handlers)
        elif isinstance(node, ast.BoolOp):
            mark(node.values[1:])
        elif isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp)):
            mark([node.elt])
        elif isinstance(node, ast.DictComp):
            mark([node.key, node.value])
        elif isinstance(node, ast.Match):
            mark(node.cases)
    return found


def _in_order(function):
    """The nodes of `function`'s own body in source order, children before the
    statement holding them, so a call is seen before what it's assigned to.
    Functions defined inside it are read on their own."""
    for statement in function.body:
        yield from _post_order(statement)


def _post_order(node):
    for child in ast.iter_child_nodes(node):
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            continue
        yield from _post_order(child)
    yield node


def build_graph(root, workflow):
    """Workflow `workflow`, unpacked at `root`, as a graph: its agents, which each can
    call, and the calls themselves. Raises when its config is missing or isn't valid
    YAML."""
    with open(os.path.join(root, CONFIG_PATH), encoding="utf-8") as f:
        config = yaml.safe_load(f) or {}
    specs = config.get("agents") if isinstance(config, dict) else None
    agents = [
        _Agent(root, spec)
        for spec in specs or []
        if isinstance(spec, dict) and isinstance(spec.get("name"), str)
    ]
    endpoint = config.get("endpoint") if isinstance(config, dict) else None
    if not isinstance(endpoint, dict):
        endpoint = None
    routes = [
        {
            "agent": route["agent"],
            "method": route["method"] if isinstance(route.get("method"), str) else None,
        }
        for route in (endpoint or {}).get("routes") or []
        if isinstance(route, dict) and isinstance(route.get("agent"), str)
    ]
    served = {route["agent"] for route in routes}
    stubs = {agent.path: agent for agent in agents if agent.path}

    edges, calls, notes, asks = [], [], [], {}
    for agent in agents:
        if agent.path is None:
            continue
        reader = _Reader(root, agent, stubs).read()
        asks[agent.name] = sorted(reader.asks, key=lambda a: (a["path"], a["line"]))
        calls += reader.calls
        notes += [{"agent": agent.name, **note} for note in reader.notes]
        for target in reader.references.values():
            methods = sorted(
                {c["method"] for c in reader.calls if c["target"] == target.name}
            )
            edges.append(
                {"source": agent.name, "target": target.name, "methods": methods}
            )

    return {
        "version": GRAPH_VERSION,
        "workflow": workflow,
        "routes": routes,
        "agents": [
            {
                "name": agent.name,
                "entrypoint": agent.entrypoint
                if isinstance(agent.entrypoint, str)
                else None,
                "functions": agent.functions,
                "endpoint": agent.name in served,
                # An agent without code of its own (a database) has nothing to read.
                "read": agent.path is not None,
                "asks": asks.get(agent.name, []),
            }
            for agent in agents
        ],
        "edges": edges,
        "calls": calls,
        "notes": notes,
    }
