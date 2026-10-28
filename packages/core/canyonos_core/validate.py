# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Contracts a project has to keep that the schema alone cannot see.

`validate_project` reads the manifest. What it cannot read is the Python
beside it: a class the controller loads by name, or a method the executor calls
without awaiting. Each of those survives a green build and fails inside a
container, or on its first request, so they are checked here against the same
parsed model the deploy uses -- never against a second copy of the pins, the
image Python or the runtime's module names.

    python -m canyonos_core.validate <root> [--json]

Exit 0 when the project is clean, 1 when anything was found, and 2 when it could
not be checked because `config/global_controller.yaml` is missing.
"""

import argparse
import ast
import json
import os
import sys
from typing import NamedTuple

from canyonos_core.schema import CONFIG_PATH, CodeAgent, check_project
from canyonos_core.stub_generator import AGENT_FLAT_MODULES

UNCHECKED = 2


class ManifestNotFound(RuntimeError):
    """Raised by `validate_root` when the project has no manifest to check."""


class Finding(NamedTuple):
    """One rejected contract: where it is written, and what breaks if it ships."""

    code: str
    path: str
    line: int
    summary: str
    mechanism: str


# ------------------------------------------------------------------ #
#  Python source                                                       #
# ------------------------------------------------------------------ #


def _parse(path):
    """`(AST, None)` or `(None, error)`, without importing the file.

    Decoded the way the runtime decodes it. An import honours the coding
    cookie, so the bytes go to the parser.
    """
    try:
        with open(path, "rb") as handle:
            source = handle.read()
    except OSError as exc:
        return None, str(exc)
    try:
        return ast.parse(source, filename=path), None
    except SyntaxError as exc:
        return None, f"{exc.msg} (line {exc.lineno})"
    except ValueError as exc:
        # A null byte, which Python 3.10 reports as ValueError.
        return None, str(exc)


def _parameter_names(node):
    """Every keyword-callable parameter, excluding `self`/`cls`."""
    args = node.args
    positional = [arg.arg for arg in args.args]
    if not args.posonlyargs and positional and positional[0] in ("self", "cls"):
        positional = positional[1:]
    return positional + [arg.arg for arg in args.kwonlyargs]


def _positional_only(node, sent):
    """Parameters before `/` that a call passing `sent` by keyword breaks.

    A required one is never filled. A sent name aimed at one raises TypeError,
    or with `**kwargs` lands there instead and the parameter keeps its default.
    """
    names = [arg.arg for arg in node.args.posonlyargs]
    if names and names[0] in ("self", "cls"):
        names = names[1:]
    required = _required_parameters(node)
    return [name for name in names if name in required or name in sent]


def _required_parameters(node):
    """Parameters with no default, excluding `self`/`cls`."""
    args = node.args
    positional = [arg.arg for arg in args.posonlyargs + args.args]
    if positional and positional[0] in ("self", "cls"):
        positional = positional[1:]
    if args.defaults:
        positional = positional[: len(positional) - len(args.defaults)]
    kwonly = [
        arg.arg
        for arg, default in zip(args.kwonlyargs, args.kw_defaults)
        if default is None
    ]
    return positional + kwonly


def _module_path(entrypoint):
    """The dotted module name an entrypoint has inside the container.

    Normalized first: `./agents/x.py` is the same module as `agents/x.py`, and
    the schema accepts both.
    """
    normalized = os.path.normpath(entrypoint.replace("\\", "/"))
    return os.path.splitext(normalized)[0].replace(os.sep, "/").replace("/", ".")


# ------------------------------------------------------------------ #
#  Checks                                                              #
# ------------------------------------------------------------------ #


class _Class(NamedTuple):
    """A class statement, and the file and module it was read from."""

    node: ast.ClassDef
    path: str
    tree: ast.Module


# A name bound by something that only running the module could follow: a call,
# an installed package, a star import, a conditional definition.
_UNREADABLE = "unreadable"


def _inside(root, path):
    """Whether `path` resolves to a file under `root`, symlinks followed."""
    real_root = os.path.realpath(root)
    try:
        common = os.path.commonpath([real_root, os.path.realpath(path)])
    except ValueError:
        # A different drive on Windows.
        return False
    return common == real_root


def _binds(node, name):
    """Whether anything inside `node` binds `name`."""
    for child in ast.walk(node):
        if isinstance(child, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            if child.name == name:
                return True
        elif isinstance(child, ast.Name) and isinstance(child.ctx, ast.Store):
            if child.id == name:
                return True
        elif isinstance(child, (ast.Import, ast.ImportFrom)):
            for alias in child.names:
                if alias.name == "*" or (alias.asname or alias.name) == name:
                    return True
    return False


def _imported_file(root, path, node):
    """The source file an `ImportFrom` reads, or None outside the project."""
    if node.level:
        package = os.path.dirname(os.path.relpath(path, root))
        for _ in range(node.level - 1):
            package = os.path.dirname(package)
        parts = package.split(os.sep) if package else []
    else:
        parts = []
    parts += node.module.split(".") if node.module else []
    base = os.path.join(root, *parts)
    for candidate in (base + ".py", os.path.join(base, "__init__.py")):
        if os.path.isfile(candidate) and _inside(root, candidate):
            return candidate
    return None


def _resolve_class(root, path, tree, name, seen=frozenset()):
    """What `name` is at module level: a `_Class`, None, or `_UNREADABLE`.

    Follows what the controller's getattr(module, name) would reach without
    running anything: a class statement, an alias of another name, and a
    `from ... import` of a module in the project.
    """
    if (path, name) in seen:
        return _UNREADABLE
    seen = seen | {(path, name)}

    binding = None
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == name:
            binding = _Class(node, path, tree)
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            if any(isinstance(t, ast.Name) and t.id == name for t in targets):
                value = node.value
                binding = (
                    _resolve_class(root, path, tree, value.id, seen)
                    if isinstance(value, ast.Name)
                    else _UNREADABLE
                )
        elif isinstance(node, ast.ImportFrom):
            alias = next(
                (
                    a
                    for a in node.names
                    if a.name == "*" or (a.asname or a.name) == name
                ),
                None,
            )
            if alias is not None:
                binding = _UNREADABLE
                imported = _imported_file(root, path, node)
                if alias.name != "*" and imported is not None:
                    imported_tree, _ = _parse(imported)
                    if imported_tree is not None:
                        binding = _resolve_class(
                            root, imported, imported_tree, alias.name, seen
                        )
        elif _binds(node, name):
            binding = _UNREADABLE
    return binding


def _methods(root, cls, seen=frozenset()):
    """`({name: (node, path) or None}, complete)` for a class and its bases.

    None is an attribute bound some other way than `def`, which only running
    the class would read. Incomplete when a base cannot be read, or the class
    answers any name through `__getattr__`: either may supply anything.
    """
    methods = {}
    for node in cls.node.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            methods[node.name] = (node, cls.path)
        else:
            for child in ast.walk(node):
                if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Store):
                    methods[child.id] = None
    complete = "__getattr__" not in methods
    seen = seen | {(cls.path, cls.node.name)}
    for base in cls.node.bases:
        if isinstance(base, ast.Name) and base.id == "object":
            continue
        resolved = (
            _resolve_class(root, cls.path, cls.tree, base.id)
            if isinstance(base, ast.Name)
            else _UNREADABLE
        )
        if not isinstance(resolved, _Class) or (
            (resolved.path, resolved.node.name) in seen
        ):
            complete = False
            continue
        inherited, base_complete = _methods(root, resolved, seen)
        complete = complete and base_complete
        for name, found in inherited.items():
            methods.setdefault(name, found)
    return methods, complete


def _check_adapter(report, root, entrypoint_path, agent_spec):
    """The class the controller loads, and the methods it calls on it."""
    tree, error = _parse(entrypoint_path)
    if tree is None:
        report.add(
            "CANYON-ADAPTER-CLASS",
            entrypoint_path,
            0,
            f"the entrypoint does not parse: {error}",
            "_load_agent exec_module's it and swallows the exception; the first "
            "request answers 'No agent loaded'.",
        )
        return

    cls = _resolve_class(root, entrypoint_path, tree, agent_spec.name)
    if cls is _UNREADABLE:
        return
    if cls is None:
        defined = [node.name for node in tree.body if isinstance(node, ast.ClassDef)]
        found = ", ".join(defined) if defined else "no classes at all"
        report.add(
            "CANYON-ADAPTER-CLASS",
            entrypoint_path,
            1,
            f"no class named `{agent_spec.name}` at module level (found: {found})",
            "_load_agent does getattr(module, CANYONOS_AGENT_NAME) and swallows "
            "the AttributeError. The class name must equal the entry's name exactly.",
        )
        return

    methods, complete = _methods(root, cls)
    _check_constructor(report, agent_spec.name, methods)
    for function in agent_spec.functions:
        _check_method(report, cls.path, agent_spec.name, function, methods, complete)


def _check_constructor(report, name, methods):
    """The controller constructs the agent with no arguments."""
    if methods.get("__init__") is None:
        return
    init, path = methods["__init__"]
    required = _required_parameters(init)
    if not required:
        return
    report.add(
        "CANYON-ADAPTER-INIT",
        path,
        init.lineno,
        f"`{name}.__init__` requires {', '.join(required)}",
        "_load_agent calls agent_class() with no arguments; the TypeError is "
        "swallowed and the first request answers 'No agent loaded'. Read "
        "configuration from the environment inside __init__ instead.",
    )


def _check_method(report, class_path, class_name, function, methods, complete):
    """One declared function against the method it is generated from."""
    if function.name not in methods:
        if not complete:
            return
        report.add(
            "CANYON-ADAPTER-SIGNATURE",
            class_path,
            0,
            f"`{class_name}` has no method `{function.name}`",
            "Its `functions` entry gives callers a stub for it; the controller then "
            f"answers \"Agent {class_name} has no method '{function.name}'\".",
        )
        return
    if methods[function.name] is None:
        return
    method, path = methods[function.name]

    if isinstance(method, ast.AsyncFunctionDef):
        report.add(
            "CANYON-ADAPTER-ASYNC",
            path,
            method.lineno,
            f"`{class_name}.{function.name}` is `async def`",
            "The executor calls method(**args) with no await, so Redis receives "
            "'<coroutine object ...>'. Keep the signature synchronous and call "
            "asyncio.run(...) inside the body.",
        )

    declared = [argument.name for argument in function.arguments]
    positional_only = _positional_only(method, declared)
    if positional_only:
        report.add(
            "CANYON-ADAPTER-SIGNATURE",
            path,
            method.lineno,
            f"`{class_name}.{function.name}` takes "
            f"{', '.join(positional_only)} positional-only (before `/`)",
            "The controller does method(**args), passing every argument by "
            "keyword, so a parameter before `/` never receives it: TypeError at "
            "request time, or with **kwargs the value lands there and the "
            "parameter keeps its default. Move it after the `/`.",
        )

    actual = _parameter_names(method)
    missing = (
        []
        if method.args.kwarg is not None
        else [
            name
            for name in declared
            if name not in actual and name not in positional_only
        ]
    )
    if missing:
        report.add(
            "CANYON-ADAPTER-SIGNATURE",
            path,
            method.lineno,
            f"`{class_name}.{function.name}` has no parameter "
            f"{', '.join(repr(name) for name in missing)}, but its `functions` "
            "entry declares it",
            "The controller does method(**args) with the declared argument "
            "names. A mismatch is TypeError: unexpected keyword argument, at "
            "request time.",
        )

    unfilled = [
        name
        for name in _required_parameters(method)
        if name not in declared and name not in positional_only
    ]
    if unfilled:
        report.add(
            "CANYON-ADAPTER-SIGNATURE",
            path,
            method.lineno,
            f"`{class_name}.{function.name}` requires {', '.join(unfilled)}, "
            "which its `functions` entry does not declare",
            "Only declared arguments are ever sent, and the generated stub "
            "gives none of them a default. Declare them in the agent's "
            "functions or default them in the signature.",
        )


def _check_flat_collisions(report, root):
    """A project module at the source root the runtime's own copy lands on."""
    for entry in sorted(os.listdir(root)):
        if entry not in AGENT_FLAT_MODULES:
            continue
        path = os.path.join(root, entry)
        if not os.path.isfile(path):
            continue
        report.add(
            "CANYON-FLAT-COLLISION",
            path,
            1,
            f"a project module named `{entry}` sits at the root of the source copy",
            "The shared CanyonOS Core runtime is copied flat into the image "
            f"after the project sweep, so this file is replaced by Core's own "
            f"{entry}. Rename it or move it into a package directory.",
        )


def _check_package_reexport(report, root, agent_spec):
    """The entrypoint's package must not import from the entrypoint itself.

    Python runs a package's `__init__.py` before any of its submodules, and in
    every image except this agent's own the module at the entrypoint is the
    generated stub, which defines the agent class and nothing else.
    """
    package, _, module = _module_path(agent_spec.entrypoint).rpartition(".")
    if not package:
        return
    init_path = os.path.join(root, *package.split("."), "__init__.py")
    if not os.path.isfile(init_path):
        return

    tree, _ = _parse(init_path)
    if tree is None:
        return

    for node in ast.walk(tree):
        if not isinstance(node, ast.ImportFrom):
            continue
        target = node.module or ""
        if node.level:
            hit = target == module or (
                not node.module and any(alias.name == module for alias in node.names)
            )
        else:
            hit = target in (module, f"{package}.{module}")
        if not hit:
            continue
        report.add(
            "CANYON-PACKAGE-REEXPORT",
            init_path,
            node.lineno,
            f"`{package}/__init__.py` re-exports from `{module}`, the "
            f"entrypoint for {agent_spec.name}",
            f"Any peer image that imports anything from `{package}` re-runs "
            "this re-export against the stub and dies at container startup with "
            f"ImportError. Point `entrypoint` at a module `{package}/"
            "__init__.py` does not re-export from; add one that imports the "
            "real module if every existing module is re-exported.",
        )
        return


# ------------------------------------------------------------------ #
#  Driver                                                              #
# ------------------------------------------------------------------ #


class _Report:
    """The findings so far, with every path written relative to the project root."""

    def __init__(self, root):
        self.root = root
        self.findings = []

    def add(self, code, path, line, summary, mechanism):
        self.findings.append(
            Finding(code, self.relative(path), line or 0, summary, mechanism)
        )

    def relative(self, path):
        if not path:
            return ""
        try:
            return os.path.relpath(path, self.root)
        except ValueError:
            # A different drive on Windows: the absolute path is all there is.
            return path


def validate_root(root):
    """Every violation in the project at `root`, schema first, contracts after.

    Raise `ManifestNotFound` when `root` holds no manifest; otherwise never raise,
    and leave the caller to decide how to report. Schema violations come back
    as `CANYON-SCHEMA` findings, and when the manifest itself does not parse they
    are all there is -- the rest of the checks have no model to run over.
    """
    root = os.path.abspath(root)
    config_path = os.path.join(root, CONFIG_PATH)
    if not os.path.isfile(config_path):
        raise ManifestNotFound(
            f"{CONFIG_PATH} not found in {root}, so nothing was checked."
        )

    report = _Report(root)
    manifest, violations = check_project(config_path, root)
    for violation in violations:
        report.add(
            "CANYON-SCHEMA",
            violation.path,
            violation.line,
            f"{violation.field}: {violation.message}"
            if violation.field
            else violation.message,
            "The in-container deploy runs this same check before it generates a "
            "single stub, and rejects the project rather than building it.",
        )

    if manifest is None:
        return _sorted(report.findings)

    for agent_spec in manifest.agents:
        if not isinstance(agent_spec, CodeAgent):
            continue
        entrypoint_path = os.path.join(root, agent_spec.entrypoint)
        if not os.path.isfile(entrypoint_path) or not _inside(root, entrypoint_path):
            continue  # reported by check_project
        _check_adapter(report, root, entrypoint_path, agent_spec)
        _check_package_reexport(report, root, agent_spec)

    _check_flat_collisions(report, root)
    return _sorted(report.findings)


def _sorted(findings):
    """Grouped by code, then by where they are."""
    return sorted(
        findings, key=lambda finding: (finding.code, finding.path, finding.line)
    )


# ------------------------------------------------------------------ #
#  Entry point                                                         #
# ------------------------------------------------------------------ #


def payload(root, findings):
    """The JSON object `--json` prints, and the CLI renders from."""
    return {
        "root": root,
        "errors": len(findings),
        "findings": [finding._asdict() for finding in findings],
    }


def _print_text(findings):
    for finding in findings:
        where = finding.path
        if where and finding.line:
            where = f"{where}:{finding.line}"
        print(f"{finding.code}  {where}".rstrip())
        print(f"    {finding.summary}")
        if finding.mechanism:
            print(f"      {finding.mechanism}")
        print()
    print(f"{len(findings)} error(s)." if findings else "clean.")


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="python -m canyonos_core.validate",
        description="Check a project against the CanyonOS contract.",
    )
    parser.add_argument(
        "root",
        nargs="?",
        default=".",
        help="the project directory holding config/ (default: the cwd)",
    )
    parser.add_argument("--json", action="store_true", help="emit findings as JSON")
    args = parser.parse_args(argv)

    try:
        findings = validate_root(args.root)
    except ManifestNotFound as error:
        print(str(error), file=sys.stderr)
        if args.json:
            print(
                json.dumps(
                    {
                        "root": os.path.abspath(args.root),
                        "errors": None,
                        "error": str(error),
                    }
                )
            )
        return UNCHECKED
    if args.json:
        print(json.dumps(payload(os.path.abspath(args.root), findings)))
    else:
        _print_text(findings)
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
