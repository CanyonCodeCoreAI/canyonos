# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Lets agent code use an agent call's result as if the call had returned it, waiting
only at the line that first needs the value.

A call to another agent returns a Future at once. The Local Controller loads the
agent's own modules through this module, which rewrites each one as it is imported:

- A line that uses a value (`a + b`, `if a:`, `a["k"]`, `a.strip()`, `f"{a}"`,
  `for x in a`, `x, y = a`) first turns a Future into its result, as the type its
  function declares in `workflow_config.yaml`. `await a` waits for it without
  blocking the event loop.
- A line that only passes a value along (`x = a`, `[a, b]`, `return a`) leaves it
  a Future, so nothing waits.
- A call decides when it runs. Another agent's call and the project's own functions
  take Futures as they are: the called agent's replica waits for them just before
  it runs, and the project's code is rewritten too. Anything else, such as a library,
  `print` or `json.dumps`, gets the results, inside dicts, lists and tuples too, and
  in the attributes of the project's own objects.

Only the project's files that call an agent are rewritten: those that import an
agent's stub, directly or through another of the project's files that does. Every
other file, such as a helper module or an agent that calls no other, is loaded as
written and runs at full speed; a call from rewritten code hands it results, as it
does a library. The standard library, installed packages, CanyonOS's own modules and
the generated agent stubs are never rewritten. A file with a
`# canyonos: no-rewrite` line is loaded as written. Setting `CANYONOS_LAZY_VALUES=0`
in an agent's environment turns all of this off.
"""

import ast
import asyncio
import collections
import functools
import importlib.abc
import importlib.machinery
import importlib.util
import logging
import operator
import os
import re
import sys
import threading
import types
import warnings

try:
    from canyonos_core.controller.future import LIVE_FUTURES, Future
except ImportError:
    from future import LIVE_FUTURES, Future

# A line in a file that keeps it from being rewritten. The generated stubs carry it.
NO_REWRITE_PRAGMA = "# canyonos: no-rewrite"

# CanyonOS's own modules at the image root (stub_generator._AGENT_FLAT_SOURCES), which
# are never agent code. A test keeps this in step with that list.
CANYONOS_FLAT_FILES = frozenset(
    {
        "future.py",
        "canyonos_context.py",
        "gateway_headers.py",
        "canyonos_governance.py",
        "canyonos_health.py",
        "canyonos_lazy.py",
        "local_controller.py",
        "local_controller_frontend.py",
        "redis_client.py",
        "grpc_options.py",
        "log_entry.py",
        "gpu_metrics.py",
        "log_handler.py",
        "human_input.py",
    }
)

# Directories under the project that hold someone else's code: the image's copy of
# the LLM Gateway, and a virtualenv left in the project.
_SKIPPED_DIRECTORIES = frozenset(
    {"canyonos_core", "site-packages", "dist-packages", ".venv", "venv"}
)

# Names the rewritten code calls; each module gets them as globals before it runs.
_USE, _USE_ATTRIBUTE, _CALL = "__canyon_use__", "__canyon_use_attr__", "__canyon_call__"
_AUG_NAME, _AUG_ATTRIBUTE, _AUG_ITEM = (
    "__canyon_aug__",
    "__canyon_aug_attr__",
    "__canyon_aug_item__",
)
_UNPACK, _UNPACK_EACH = "__canyon_unpack__", "__canyon_unpack_each__"

# Calls that look at the calling frame, which a call through __canyon_call__ would
# change: they are left as written.
_FRAME_NAMES = frozenset(
    {"super", "locals", "vars", "globals", "dir", "eval", "exec", "breakpoint"}
)
_FRAME_ATTRIBUTES = frozenset({"_getframe", "currentframe", "stack"})

# The Future's methods that decide when to wait, always read on the Future rather
# than on its result, so code written with `.value()` keeps working. Any other
# attribute is read on the result, or on the Future when the result has no such
# attribute (see use_attribute).
FUTURE_ATTRIBUTES = frozenset({"value", "resolved", "is_available"})

_REWRITTEN_FILES = set()
_REWRITTEN_MODULES = set()
# Every module loaded from the project's files, rewritten or not: a library handed
# one of their objects gets the Futures on it resolved (see _replace_attributes).
_PROJECT_MODULES = set()
_install_lock = threading.Lock()
_installed_roots = set()


# --------------------------------------------------------------------------- #
#  What rewritten code calls                                                   #
# --------------------------------------------------------------------------- #


def use(value):
    """A value as a line uses it: a Future's result, as its declared type, waiting for
    it if it isn't in yet. Anything else as it is."""
    __tracebackhide__ = True
    if isinstance(value, Future):
        return value.resolved()
    return value


def use_attribute(value, name):
    """The object `value.name` reads from. For a Future: the Future itself for
    `.value`, `.resolved` and `.is_available`; otherwise its result, unless the
    result has no `name` and the Future has, such as `.id`. Anything else as it is."""
    __tracebackhide__ = True
    if not isinstance(value, Future) or name in FUTURE_ATTRIBUTES:
        return value
    result = value.resolved()
    if not hasattr(result, name) and hasattr(value, name):
        return value
    return result


def unpack(value, shape):
    """`value` ready for `targets = value`, where `shape` mirrors the targets: None
    for a name, "*" for a starred one, and a tuple for a nested `(a, b)`. The value
    and each item a nested target unpacks are results; the rest stay as they are."""
    __tracebackhide__ = True
    value = use(value)
    if not any(isinstance(part, tuple) for part in shape):
        return value
    items = list(value)
    star = shape.index("*") if "*" in shape else None
    for index, part in enumerate(shape):
        if not isinstance(part, tuple):
            continue
        position = index
        if star is not None and index > star:
            position = len(items) - (len(shape) - index)
        # A count that doesn't fit is left for Python's own unpacking to report.
        if 0 <= position < len(items):
            items[position] = unpack(items[position], part)
    return items


def unpack_each(iterable, shape):
    """Each item of `iterable` ready for a loop's `for a, b in ...` (see unpack)."""
    for item in use(iterable):
        yield unpack(item, shape)


_CONTAINERS = (dict, list, tuple, set, frozenset)


def _may_hold_futures(kind):
    """True for a type whose objects can be or hold a Future: a Future, a container,
    or one of the project's own classes."""
    return (
        issubclass(kind, Future)
        or kind in _CONTAINERS
        or kind.__module__ in _PROJECT_MODULES
    )


def _replace_futures(value, seen):
    """`value` with every Future in it, at any depth of dicts, lists, tuples and sets,
    replaced by its result. The same object when it holds none. An object of one of
    the project's own classes is kept, with the Futures in its attributes replaced in
    place (see _replace_attributes)."""
    if isinstance(value, Future):
        return value.resolved()
    kind = type(value)
    if id(value) in seen:
        return value
    if kind not in _CONTAINERS:
        if kind.__module__ in _PROJECT_MODULES:
            _replace_attributes(value, seen)
        return value
    # The kinds of items, gathered at C speed, so a list of 20,000 strings is not
    # walked item by item when nothing in it can be a Future.
    kinds = set(map(type, value))
    if kind is dict:
        kinds.update(map(type, value.values()))
    if not any(map(_may_hold_futures, kinds)):
        return value
    seen.add(id(value))
    try:
        if kind is dict:
            items = [
                (_replace_futures(k, seen), _replace_futures(v, seen))
                for k, v in value.items()
            ]
            if all(k is a and v is b for (k, v), (a, b) in zip(value.items(), items)):
                return value
            return dict(items)
        parts = [_replace_futures(v, seen) for v in value]
        if all(a is b for a, b in zip(value, parts)):
            return value
        return kind(parts)
    finally:
        seen.discard(id(value))


def _replace_attributes(value, seen):
    """Replace each Future in the attributes of `value`, an object of a project class,
    by its result, in the object itself: a library it is handed may keep it, so the
    project's code and the library go on seeing the same object. Written straight to
    `__dict__`, so a frozen dataclass or a model that checks assignments takes it."""
    attributes = getattr(value, "__dict__", None)
    if not isinstance(attributes, dict):
        return
    seen.add(id(value))
    try:
        for name, item in list(attributes.items()):
            new = _replace_futures(item, seen)
            if new is not item:
                attributes[name] = new
    finally:
        seen.discard(id(value))


# Lazy sequences a library reads item by item, such as `sum(x for x in futures)`.
_LAZY_SEQUENCES = (types.GeneratorType, map, filter)


def _resolving(items):
    """Yield each item with the Futures in it replaced, as the reader takes it."""
    for item in items:
        yield _replace_futures(item, set())


def resolve_all(value):
    """`value` with every Future in it replaced by its result, for code that looks
    inside what it is given. A generator, `map` or `filter` is read the same way,
    item by item, as the code reading it asks for each one."""
    __tracebackhide__ = True
    if not LIVE_FUTURES:
        return value
    if isinstance(value, _LAZY_SEQUENCES):
        return _resolving(value)
    return _replace_futures(value, set())


# How a call treats the Futures in its arguments.
_KEEP = "keep"  # takes them as they are
_SHALLOW = "shallow"  # an argument that is a Future is replaced; what it holds isn't
_DEEP = "deep"  # every Future, at any depth, is replaced

# Builtins that store or count what they're given without looking inside it.
_SHALLOW_BUILTINS = {
    id(f): f
    for f in (
        list,
        tuple,
        zip,
        enumerate,
        reversed,
        iter,
        next,
        len,
        range,
        isinstance,
        issubclass,
        type,
        id,
        bool,
        callable,
        hasattr,
        getattr,
    )
}

# asyncio calls that take awaitables, which a Future is (Future.__await__): given
# the Futures, they wait for them without blocking the event loop.
_AWAITING = {
    id(f): f
    for f in (
        asyncio.gather,
        asyncio.wait_for,
        asyncio.shield,
        asyncio.ensure_future,
        asyncio.as_completed,
    )
}

# Methods of containers, by type and name, and how they treat their arguments.
_CONTAINER_METHODS = {
    list: {
        "append": _KEEP,
        "insert": _KEEP,
        "extend": _SHALLOW,
        "copy": _SHALLOW,
        "pop": _SHALLOW,
    },
    dict: {
        "update": _SHALLOW,
        "setdefault": _SHALLOW,
        "get": _SHALLOW,
        "pop": _SHALLOW,
        "keys": _SHALLOW,
        "values": _SHALLOW,
        "items": _SHALLOW,
        "copy": _SHALLOW,
    },
    collections.deque: {
        "append": _KEEP,
        "appendleft": _KEEP,
        "extend": _SHALLOW,
        "extendleft": _SHALLOW,
    },
}

_LOG_METHODS = frozenset(
    {
        "debug",
        "info",
        "warning",
        "warn",
        "error",
        "exception",
        "critical",
        "fatal",
        "log",
    }
)
_FRAME_COUNTING = {
    id(f): f
    for f in (
        warnings.warn,
        logging.debug,
        logging.info,
        logging.warning,
        logging.error,
        logging.exception,
        logging.critical,
        logging.log,
    )
}


def _code_is_rewritten(func):
    """True when `func` is a function or method whose code was rewritten."""
    target = getattr(func, "__func__", func)
    code = getattr(target, "__code__", None)
    return code is not None and code.co_filename in _REWRITTEN_FILES


def _is_project_code(func):
    """True when calling `func` runs rewritten code first, which waits for a Future
    where it uses it: a project function or method, a project class whose own
    `__init__` takes the arguments, or a project object's `__call__`. A class whose
    arguments reach a library first, such as a pydantic model, is not."""
    if isinstance(func, functools.partial):
        func = func.func
    if isinstance(func, type):
        return func.__new__ is object.__new__ and _code_is_rewritten(func.__init__)
    if _code_is_rewritten(func):
        return True
    return not hasattr(func, "__code__") and _code_is_rewritten(
        getattr(type(func), "__call__", None)
    )


def _treatment(func):
    """How a call to `func` treats Futures in its positional and keyword arguments."""
    owner = getattr(func, "__self__", None)
    if (
        func is Future
        or id(func) in _AWAITING
        or getattr(type(owner), "__canyon_stub__", False)
    ):
        return _KEEP, _KEEP
    if id(func) in _SHALLOW_BUILTINS:
        return _SHALLOW, _SHALLOW
    if func is dict:
        # dict(a=future) stores it; dict(pairs) only needs the pairs.
        return _SHALLOW, _KEEP
    for kind, methods in _CONTAINER_METHODS.items():
        if type(owner) is kind and getattr(func, "__name__", None) in methods:
            treatment = methods[func.__name__]
            return treatment, (_KEEP if treatment == _KEEP else _SHALLOW)
    if _is_project_code(func):
        return _KEEP, _KEEP
    return _DEEP, _DEEP


def _apply(treatment, value):
    """One argument as a call with this treatment receives it."""
    if treatment == _KEEP:
        return value
    if treatment == _SHALLOW:
        return use(value)
    return resolve_all(value)


def _counts_frames(func):
    """True for logging and `warnings.warn`, which name the line that called them by
    counting frames, so a call through __canyon_call__ has to skip its own."""
    if id(func) in _FRAME_COUNTING:
        return True
    owner = getattr(func, "__self__", None)
    return (
        isinstance(owner, (logging.Logger, logging.LoggerAdapter))
        and getattr(func, "__name__", None) in _LOG_METHODS
    )


def call(func, /, *args, **kwargs):
    """Make a call written in agent code, giving each argument as `func` should get
    it (see _treatment)."""
    __tracebackhide__ = True
    func = use(func)
    if LIVE_FUTURES:
        positional, keyword = _treatment(func)
        if positional != _KEEP:
            args = tuple(_apply(positional, value) for value in args)
        if keyword != _KEEP and kwargs:
            kwargs = {name: _apply(keyword, value) for name, value in kwargs.items()}
    if _counts_frames(func):
        kwargs["stacklevel"] = kwargs.get("stacklevel", 1) + 1
    return func(*args, **kwargs)


_AUG_OPERATORS = {
    ast.Add: operator.iadd,
    ast.Sub: operator.isub,
    ast.Mult: operator.imul,
    ast.MatMult: operator.imatmul,
    ast.Div: operator.itruediv,
    ast.FloorDiv: operator.ifloordiv,
    ast.Mod: operator.imod,
    ast.Pow: operator.ipow,
    ast.LShift: operator.ilshift,
    ast.RShift: operator.irshift,
    ast.BitOr: operator.ior,
    ast.BitXor: operator.ixor,
    ast.BitAnd: operator.iand,
}
_AUG_BY_NAME = {kind.__name__: op for kind, op in _AUG_OPERATORS.items()}


def augment(op_name, current, value):
    """`current op= value` for a variable, on the results of any Futures."""
    __tracebackhide__ = True
    return _AUG_BY_NAME[op_name](use(current), use(value))


def augment_attribute(owner, name, op_name, value):
    """`owner.name op= value`, on the results of any Futures."""
    __tracebackhide__ = True
    setattr(owner, name, augment(op_name, getattr(owner, name), value))


def augment_item(owner, key, op_name, value):
    """`owner[key] op= value`, on the results of any Futures."""
    __tracebackhide__ = True
    owner[key] = augment(op_name, owner[key], value)


_HELPERS = {
    _USE: use,
    _USE_ATTRIBUTE: use_attribute,
    _CALL: call,
    _AUG_NAME: augment,
    _AUG_ATTRIBUTE: augment_attribute,
    _AUG_ITEM: augment_item,
    _UNPACK: unpack,
    _UNPACK_EACH: unpack_each,
}


# --------------------------------------------------------------------------- #
#  The rewrite                                                                 #
# --------------------------------------------------------------------------- #


def _helper(name, *args):
    """A call to one of the helpers above, as a syntax node."""
    return ast.Call(
        func=ast.Name(id=name, ctx=ast.Load()), args=list(args), keywords=[]
    )


def _index_value(node):
    """An index as a value that can be passed to a function: `a:b` becomes
    `slice(a, b, None)`, inside a tuple too."""
    if isinstance(node, ast.Slice):
        parts = [
            p if p is not None else ast.Constant(None)
            for p in (node.lower, node.upper, node.step)
        ]
        return ast.Call(
            func=ast.Name(id="slice", ctx=ast.Load()), args=parts, keywords=[]
        )
    if isinstance(node, ast.Tuple):
        return ast.Tuple(elts=[_index_value(e) for e in node.elts], ctx=ast.Load())
    return node


def _unpacks(target):
    """True for a target that unpacks what it is given: `a, b` or `[a, b]`."""
    return isinstance(target, (ast.Tuple, ast.List))


def _shape(target):
    """The shape `unpack` takes for an unpacking target (see unpack)."""
    return tuple(
        "*" if isinstance(e, ast.Starred) else _shape(e) if _unpacks(e) else None
        for e in target.elts
    )


class _Rewriter(ast.NodeTransformer):
    """Rewrites one module so each place that uses a value goes through `use`, each
    call through `call`, and everything that only passes a value along is left."""

    def __init__(self, module_names):
        # Names bound to imported modules, whose attributes are never Futures.
        self._module_names = module_names

    def _use(self, node):
        if node is None or isinstance(
            node, (ast.Constant, ast.JoinedStr, ast.Lambda, ast.Starred, ast.Slice)
        ):
            return node
        return ast.copy_location(_helper(_USE, node), node)

    def _use_index(self, node):
        """An index or key, where `a:b` parts and the parts of `a:b, i` are used one
        by one, since a slice can't be passed to a function as written."""
        if isinstance(node, ast.Slice):
            node.lower, node.upper, node.step = (
                self._use(node.lower),
                self._use(node.upper),
                self._use(node.step),
            )
            return node
        if isinstance(node, ast.Tuple) and any(
            isinstance(e, ast.Slice) for e in node.elts
        ):
            node.elts = [self._use_index(e) for e in node.elts]
            return node
        return self._use(node)

    def _visit_body(self, node, fields):
        for field in fields:
            value = getattr(node, field, None)
            if isinstance(value, list):
                setattr(node, field, self._visit_list(value))
            elif isinstance(value, ast.AST):
                setattr(node, field, self.visit(value))

    def _visit_list(self, nodes):
        result = []
        for node in nodes:
            new = self.visit(node)
            if new is None:
                continue
            result.extend(new if isinstance(new, list) else [new])
        return result

    # Definitions: annotations are left alone, since they describe types and run
    # at import; defaults and decorators are ordinary expressions.
    def _visit_function(self, node):
        node.decorator_list = self._visit_list(node.decorator_list)
        node.args.defaults = self._visit_list(node.args.defaults)
        node.args.kw_defaults = [
            self.visit(d) if d is not None else None for d in node.args.kw_defaults
        ]
        node.body = self._visit_list(node.body)
        return node

    visit_FunctionDef = visit_AsyncFunctionDef = _visit_function

    def visit_Lambda(self, node):
        node.args.defaults = self._visit_list(node.args.defaults)
        node.args.kw_defaults = [
            self.visit(d) if d is not None else None for d in node.args.kw_defaults
        ]
        node.body = self.visit(node.body)
        return node

    def visit_ClassDef(self, node):
        node.decorator_list = self._visit_list(node.decorator_list)
        node.bases = self._visit_list(node.bases)
        node.keywords = self._visit_list(node.keywords)
        node.body = self._visit_list(node.body)
        return node

    def visit_AnnAssign(self, node):
        self._visit_body(node, ("target", "value"))
        return node

    def visit_arg(self, node):
        return node

    # Uses of a value.
    def visit_BinOp(self, node):
        self.generic_visit(node)
        node.left, node.right = self._use(node.left), self._use(node.right)
        return node

    def visit_UnaryOp(self, node):
        self.generic_visit(node)
        node.operand = self._use(node.operand)
        return node

    def visit_BoolOp(self, node):
        self.generic_visit(node)
        node.values = [self._use(v) for v in node.values]
        return node

    def visit_Compare(self, node):
        self.generic_visit(node)
        node.left = self._use(node.left)
        node.comparators = [self._use(c) for c in node.comparators]
        return node

    def _visit_test(self, node):
        self.generic_visit(node)
        node.test = self._use(node.test)
        return node

    visit_If = visit_While = visit_IfExp = _visit_test

    def visit_Assert(self, node):
        self.generic_visit(node)
        node.test, node.msg = self._use(node.test), self._use(node.msg)
        return node

    def _iter(self, iterable, target, is_async):
        """What a loop over `iterable` into `target` iterates: each item ready for
        the target to unpack, when it does (an async loop's items are its own)."""
        if _unpacks(target) and not is_async:
            return ast.copy_location(
                _helper(_UNPACK_EACH, iterable, ast.Constant(_shape(target))),
                iterable,
            )
        return self._use(iterable)

    def visit_For(self, node):
        self.generic_visit(node)
        node.iter = self._iter(node.iter, node.target, is_async=False)
        return node

    def visit_AsyncFor(self, node):
        self.generic_visit(node)
        node.iter = self._use(node.iter)
        return node

    def visit_comprehension(self, node):
        self.generic_visit(node)
        node.iter = self._iter(node.iter, node.target, node.is_async)
        node.ifs = [self._use(i) for i in node.ifs]
        return node

    def visit_Assign(self, node):
        self.generic_visit(node)
        unpacking = [t for t in node.targets if _unpacks(t)]
        if len(node.targets) == 1 and unpacking:
            node.value = ast.copy_location(
                _helper(_UNPACK, node.value, ast.Constant(_shape(unpacking[0]))),
                node.value,
            )
        elif unpacking:
            # `a = b, c = value`: `a` gets the result too, since it has to be read.
            node.value = self._use(node.value)
        return node

    def visit_withitem(self, node):
        self.generic_visit(node)
        node.context_expr = self._use(node.context_expr)
        return node

    def visit_Raise(self, node):
        self.generic_visit(node)
        node.exc, node.cause = self._use(node.exc), self._use(node.cause)
        return node

    def visit_Subscript(self, node):
        self.generic_visit(node)
        node.value = self._use(node.value)
        node.slice = self._use_index(node.slice)
        return node

    def visit_Attribute(self, node):
        self.generic_visit(node)
        value = node.value
        if isinstance(value, ast.Name) and (
            value.id in ("self", "cls") or value.id in self._module_names
        ):
            return node
        node.value = ast.copy_location(
            _helper(_USE_ATTRIBUTE, value, ast.Constant(node.attr)), value
        )
        return node

    def visit_FormattedValue(self, node):
        self.generic_visit(node)
        node.value = self._use(node.value)
        return node

    def visit_Starred(self, node):
        self.generic_visit(node)
        if isinstance(node.ctx, ast.Load):
            node.value = self._use(node.value)
        return node

    def visit_Dict(self, node):
        self.generic_visit(node)
        # A key is hashed, and `**value` is unpacked: both need the value.
        node.values = [
            self._use(v) if k is None else v for k, v in zip(node.keys, node.values)
        ]
        node.keys = [self._use(k) for k in node.keys]
        return node

    def visit_Set(self, node):
        self.generic_visit(node)
        node.elts = [self._use(e) for e in node.elts]
        return node

    def visit_YieldFrom(self, node):
        self.generic_visit(node)
        node.value = self._use(node.value)
        return node

    def visit_Match(self, node):
        node.subject = self._use(self.visit(node.subject))
        for case in node.cases:
            # A pattern is not an expression: `case Color.RED` must stay a dotted name.
            case.guard = self._use(self.visit(case.guard)) if case.guard else None
            case.body = self._visit_list(case.body)
        return node

    def visit_AugAssign(self, node):
        self.generic_visit(node)
        op = ast.Constant(type(node.op).__name__)
        target, value = node.target, node.value
        if isinstance(target, ast.Name):
            current = ast.Name(id=target.id, ctx=ast.Load())
            new = ast.Assign(
                targets=[target], value=_helper(_AUG_NAME, op, current, value)
            )
        elif isinstance(target, ast.Attribute):
            new = ast.Expr(
                _helper(
                    _AUG_ATTRIBUTE, target.value, ast.Constant(target.attr), op, value
                )
            )
        else:
            key = _index_value(target.slice)
            new = ast.Expr(_helper(_AUG_ITEM, target.value, key, op, value))
        return ast.copy_location(new, node)

    def visit_Call(self, node):
        self.generic_visit(node)
        func = node.func
        if (isinstance(func, ast.Name) and func.id in _FRAME_NAMES) or (
            isinstance(func, ast.Attribute) and func.attr in _FRAME_ATTRIBUTES
        ):
            return node
        for keyword in node.keywords:
            if keyword.arg is None:
                keyword.value = self._use(keyword.value)
        return ast.copy_location(
            ast.Call(
                func=ast.Name(id=_CALL, ctx=ast.Load()),
                args=[func, *node.args],
                keywords=node.keywords,
            ),
            node,
        )


def _module_names(tree):
    """Names the module binds to whole modules with a top-level `import`."""
    names = set()
    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.asname or alias.name.split(".")[0])
    return names


def rewrite(tree):
    """Rewrite a parsed module in place (see _Rewriter) and return it."""
    tree.body = _Rewriter(_module_names(tree))._visit_list(tree.body)
    return ast.fix_missing_locations(tree)


def compile_source(source, path, module_name=None):
    """Compile one module's source, rewritten unless it carries the no-rewrite line.
    Records a rewritten module so calls into it pass Futures on unresolved."""
    if isinstance(source, bytes):
        source = importlib.util.decode_source(source)
    if any(line.strip() == NO_REWRITE_PRAGMA for line in source.splitlines()):
        return compile(source, path, "exec", dont_inherit=True)
    code = compile(rewrite(ast.parse(source, path)), path, "exec", dont_inherit=True)
    _REWRITTEN_FILES.add(path)
    if module_name:
        _REWRITTEN_MODULES.add(module_name)
    return code


# --------------------------------------------------------------------------- #
#  Loading                                                                     #
# --------------------------------------------------------------------------- #


class _RewritingLoader(importlib.machinery.SourceFileLoader):
    """Loads a project file rewritten. Nothing is cached in `__pycache__`, so a
    rewritten module never stands in for the file as written."""

    def get_code(self, fullname):
        path = self.get_filename(fullname)
        return compile_source(self.get_data(path), path, fullname)

    def exec_module(self, module):
        module.__dict__.update(_HELPERS)
        super().exec_module(module)


def _is_project_file(path, root):
    """True when `path` is the project's own Python code under `root`."""
    path, root = os.path.realpath(path), os.path.realpath(root)
    if not path.endswith(".py") or os.path.commonpath([path, root]) != root:
        return False
    parts = os.path.relpath(path, root).split(os.sep)
    if _SKIPPED_DIRECTORIES.intersection(parts[:-1]):
        return False
    name = parts[-1]
    if len(parts) == 1 and name in CANYONOS_FLAT_FILES:
        return False
    return not (name.endswith("_pb2.py") or name.endswith("_pb2_grpc.py"))


# A generated stub's class carries this line (stub_generator._build_stub_class).
_STUB_MARKER = re.compile(r"^\s*__canyon_stub__\s*=\s*True\s*$", re.M)

# By file: whether it is a stub, and the project files it imports.
_IMPORTS = {}
# By file: whether it calls an agent (see calls_agents).
_CALLS_AGENTS = {}


def _module_name(path, root):
    """The dotted name a file under `root` imports as: `pkg/mod.py` is `pkg.mod`."""
    name = os.path.relpath(path, root)[: -len(".py")].replace(os.sep, ".")
    return name[: -len(".__init__")] if name.endswith(".__init__") else name


def _module_file(name, root):
    """The file under `root` that module `name` loads from, or None."""
    base = os.path.join(root, *name.split("."))
    for path in (base + ".py", os.path.join(base, "__init__.py")):
        if os.path.isfile(path):
            return os.path.realpath(path)
    return None


def _imported_names(tree, package):
    """Every module name the code imports, anywhere in it, absolute: `pkg.mod` for
    `from .mod import x` in package `pkg`, and `pkg.mod.x` too, in case x is one."""
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            yield from (alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            if node.level:
                parts = package.split(".") if package else []
                parts = (
                    parts[: len(parts) - (node.level - 1)] if node.level > 1 else parts
                )
                base = ".".join([*parts, base] if base else parts)
            if base:
                yield base
            for alias in node.names:
                if alias.name != "*":
                    yield f"{base}.{alias.name}" if base else alias.name


def _scan(path, root):
    """Whether the file at `path` is a stub, and the project files it imports."""
    if path not in _IMPORTS:
        try:
            with open(path, "rb") as file:
                source = importlib.util.decode_source(file.read())
            tree = ast.parse(source, path)
        except (OSError, SyntaxError, ValueError):
            _IMPORTS[path] = (False, ())
            return _IMPORTS[path]
        name = _module_name(path, root)
        package = name if path.endswith("__init__.py") else name.rpartition(".")[0]
        files = {
            found
            for imported in _imported_names(tree, package)
            if (found := _module_file(imported, root)) and found != path
        }
        _IMPORTS[path] = (bool(_STUB_MARKER.search(source)), tuple(files))
    return _IMPORTS[path]


def calls_agents(path, root):
    """True when the project file at `path` imports an agent's stub, directly or
    through another of the project's files that does: only such a file can get a
    Future from a call, so only it is rewritten."""
    path, root = os.path.realpath(path), os.path.realpath(root)
    if path not in _CALLS_AGENTS:
        seen, pending, found = {path}, [path], False
        while pending and not found:
            for imported in _scan(pending.pop(), root)[1]:
                if _scan(imported, root)[0]:
                    found = True
                    break
                if imported not in seen and _is_project_file(imported, root):
                    seen.add(imported)
                    pending.append(imported)
        _CALLS_AGENTS[path] = found
    return _CALLS_AGENTS[path]


class _ProjectFinder(importlib.abc.MetaPathFinder):
    """Finds a module the usual way and, when it is the project's own code that
    calls an agent, loads it rewritten. Other project code loads as written."""

    def __init__(self, root):
        self.root = root

    def find_spec(self, fullname, path=None, target=None):
        spec = importlib.machinery.PathFinder.find_spec(fullname, path, target)
        if (
            spec is None
            or spec.origin is None
            or not isinstance(spec.loader, importlib.machinery.SourceFileLoader)
            or not _is_project_file(spec.origin, self.root)
        ):
            return None
        _PROJECT_MODULES.add(fullname)
        if not calls_agents(spec.origin, self.root):
            return None
        spec.loader = _RewritingLoader(fullname, spec.origin)
        return spec


def enabled():
    """False when the agent's environment sets CANYONOS_LAZY_VALUES=0."""
    return os.environ.get("CANYONOS_LAZY_VALUES", "1").strip().lower() not in (
        "0",
        "false",
        "no",
        "off",
    )


def install(root):
    """Rewrite every module imported from under `root`, the project's directory, that
    calls an agent, from now on. Does nothing when turned off, or when already done
    for `root`."""
    if not enabled():
        return
    with _install_lock:
        if root in _installed_roots:
            return
        _installed_roots.add(root)
        sys.meta_path.insert(0, _ProjectFinder(root))


def loader_for(module_name, path):
    """The loader for the agent's own entrypoint, which the Local Controller loads by
    path: one that rewrites it, or None to load it as written when this is off or
    the entrypoint calls no agent."""
    if not enabled():
        return None
    _PROJECT_MODULES.add(module_name)
    if not calls_agents(path, os.path.dirname(os.path.abspath(path))):
        return None
    return _RewritingLoader(module_name, path)
