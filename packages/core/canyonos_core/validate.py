"""Contracts a `.car` has to keep that the schema alone cannot see.

`validate_project` reads the manifest and the agent declarations. What it
cannot read is the Python beside them: a class the controller loads by name, a
method the executor calls without awaiting, the one module the platform posts
to. Each of those survives a green build and fails inside a container, or on
its first request, so they are checked here against the same parsed model the
deploy uses -- never against a second copy of the pins, the image Python or the
runtime's module names.

    python -m canyonos_core.validate <artifact_root> [--config PATH] [--json]

Exit 1 if any error was found, 0 otherwise.
"""

import argparse
import ast
import glob
import json
import os
import sys
from typing import NamedTuple

from canyonos_core.schema import (
    AgentService,
    SchemaError,
    WorkflowService,
    load_agent_declaration,
    load_manifest,
    validate_project,
)
from canyonos_core.stub_generator import (
    AGENT_FLAT_MODULES,
    RESERVED_CONTEXT_NAMES,
    WORKFLOW_FLAT_MODULES,
)

# canyonos_core/cli.py SOURCE_DIR_NAME -- the copy of the application source
# that becomes /app inside every container.
SOURCE_DIR_NAME = "app"
DEFAULT_CONFIG_PATH = os.path.join("config", "global_controller.yaml")

# Modules the build writes at the context root itself. A project module of the
# same name there is either overwritten by the runtime's copy or dropped before
# the copy runs.
_FLAT_MODULES = frozenset(
    name
    for name in AGENT_FLAT_MODULES | WORKFLOW_FLAT_MODULES | RESERVED_CONTEXT_NAMES
    if name.endswith(".py")
)


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


def _parse(path, as_text=False):
    """`(AST, None)` or `(None, error)`, without importing the file.

    Decoded the way the runtime decodes it. An import honours the coding
    cookie, so by default the bytes go to the parser. The workflow launcher
    exec()s the file read as UTF-8 text, cookie ignored: `as_text` does that.
    """
    try:
        with open(path, "rb") as handle:
            source = handle.read()
        if as_text:
            source = source.decode("utf-8")
    except (OSError, UnicodeDecodeError) as exc:
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
    positional = [arg.arg for arg in args.posonlyargs + args.args]
    if positional and positional[0] in ("self", "cls"):
        positional = positional[1:]
    return positional + [arg.arg for arg in args.kwonlyargs]


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


def _inside(source_dir, path):
    """Whether `path` resolves to a file under `source_dir`, symlinks followed."""
    real_source_dir = os.path.realpath(source_dir)
    try:
        common = os.path.commonpath([real_source_dir, os.path.realpath(path)])
    except ValueError:
        # A different drive on Windows.
        return False
    return common == real_source_dir


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


def _imported_file(source_dir, path, node):
    """The source file an `ImportFrom` reads, or None outside the project."""
    if node.level:
        package = os.path.dirname(os.path.relpath(path, source_dir))
        for _ in range(node.level - 1):
            package = os.path.dirname(package)
        parts = package.split(os.sep) if package else []
    else:
        parts = []
    parts += node.module.split(".") if node.module else []
    base = os.path.join(source_dir, *parts)
    for candidate in (base + ".py", os.path.join(base, "__init__.py")):
        if os.path.isfile(candidate) and _inside(source_dir, candidate):
            return candidate
    return None


def _resolve_class(source_dir, path, tree, name, seen=frozenset()):
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
                    _resolve_class(source_dir, path, tree, value.id, seen)
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
                imported = _imported_file(source_dir, path, node)
                if alias.name != "*" and imported is not None:
                    imported_tree, _ = _parse(imported)
                    if imported_tree is not None:
                        binding = _resolve_class(
                            source_dir, imported, imported_tree, alias.name, seen
                        )
        elif _binds(node, name):
            binding = _UNREADABLE
    return binding


def _methods(source_dir, cls, seen=frozenset()):
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
            _resolve_class(source_dir, cls.path, cls.tree, base.id)
            if isinstance(base, ast.Name)
            else _UNREADABLE
        )
        if not isinstance(resolved, _Class) or (
            (resolved.path, resolved.node.name) in seen
        ):
            complete = False
            continue
        inherited, base_complete = _methods(source_dir, resolved, seen)
        complete = complete and base_complete
        for name, found in inherited.items():
            methods.setdefault(name, found)
    return methods, complete


def _check_adapter(report, source_dir, entrypoint_path, service, declaration):
    """The class the controller loads, and the methods it calls on it."""
    tree, error = _parse(entrypoint_path)
    if tree is None:
        report.add(
            "CAR-ADAPTER-CLASS",
            entrypoint_path,
            0,
            f"the entrypoint does not parse: {error}",
            "_load_agent exec_module's it and swallows the exception; the first "
            "request answers 'No agent loaded'.",
        )
        return

    cls = _resolve_class(source_dir, entrypoint_path, tree, service.name)
    if cls is _UNREADABLE:
        return
    if cls is None:
        defined = [node.name for node in tree.body if isinstance(node, ast.ClassDef)]
        found = ", ".join(defined) if defined else "no classes at all"
        report.add(
            "CAR-ADAPTER-CLASS",
            entrypoint_path,
            1,
            f"no class named `{service.name}` at module level (found: {found})",
            "_load_agent does getattr(module, CANYONOS_AGENT_NAME) and swallows "
            "the AttributeError. The class name must equal agent.name exactly.",
        )
        return

    methods, complete = _methods(source_dir, cls)
    _check_constructor(report, service.name, methods)
    if declaration is None:
        return
    for function in declaration.functions:
        _check_method(report, cls.path, service.name, function, methods, complete)


def _check_constructor(report, name, methods):
    """The controller constructs the agent with no arguments."""
    if methods.get("__init__") is None:
        return
    init, path = methods["__init__"]
    required = _required_parameters(init)
    if not required:
        return
    report.add(
        "CAR-ADAPTER-INIT",
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
            "CAR-ADAPTER-SIGNATURE",
            class_path,
            0,
            f"`{class_name}` has no method `{function.name}`",
            "The declaration gives callers a stub for it; the controller then "
            f"answers \"Agent {class_name} has no method '{function.name}'\".",
        )
        return
    if methods[function.name] is None:
        return
    method, path = methods[function.name]

    if isinstance(method, ast.AsyncFunctionDef):
        report.add(
            "CAR-ADAPTER-ASYNC",
            path,
            method.lineno,
            f"`{class_name}.{function.name}` is `async def`",
            "The executor calls method(**args) with no await, so Redis receives "
            "'<coroutine object ...>'. Keep the signature synchronous and call "
            "asyncio.run(...) inside the body.",
        )

    declared = [argument.name for argument in function.arguments]
    actual = _parameter_names(method)
    missing = (
        []
        if method.args.kwarg is not None
        else [name for name in declared if name not in actual]
    )
    if missing:
        report.add(
            "CAR-ADAPTER-SIGNATURE",
            path,
            method.lineno,
            f"`{class_name}.{function.name}` has no parameter "
            f"{', '.join(repr(name) for name in missing)}, but the declaration "
            "declares it",
            "The controller does method(**args) with the declared argument "
            "names. A mismatch is TypeError: unexpected keyword argument, at "
            "request time.",
        )

    unfilled = [name for name in _required_parameters(method) if name not in declared]
    if unfilled:
        report.add(
            "CAR-ADAPTER-SIGNATURE",
            path,
            method.lineno,
            f"`{class_name}.{function.name}` requires {', '.join(unfilled)}, "
            "which the declaration does not declare",
            "Only declared arguments are ever sent, and the generated stub "
            "gives none of them a default. Declare them in the agent YAML or "
            "default them in the signature.",
        )


def _check_workflow(report, workflow_path, stub_modules):
    """The module the platform posts to, and how it reaches an agent."""
    tree, error = _parse(workflow_path, as_text=True)
    if tree is None:
        report.add(
            "CAR-WORKFLOW-SHAPE",
            workflow_path,
            0,
            f"the workflow does not parse: {error}",
            "workflow_launcher.py exec's this file at container start; the "
            "container comes up serving nothing.",
        )
        return

    main = next(
        (
            node
            for node in tree.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name == "main"
        ),
        None,
    )
    if main is None:
        defined = [
            node.name
            for node in tree.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        ]
        found = ", ".join(defined) if defined else "no top-level functions"
        report.add(
            "CAR-WORKFLOW-SHAPE",
            workflow_path,
            1,
            f"no top-level function named `main` (found: {found})",
            "CanyonOS Core serves POST /<fn.__name__>, but the platform's test "
            "endpoint posts to a hardcoded /main. A differently named workflow "
            "builds, deploys and stays unreachable -- 404, container healthy.",
        )
    else:
        _check_main_signature(report, workflow_path, main)

    if not any(
        isinstance(node, ast.Call) and _calls_deploy(node.func, tree)
        for node in ast.walk(tree)
    ):
        report.add(
            "CAR-WORKFLOW-SHAPE",
            workflow_path,
            1,
            "the workflow never calls `deploy(...)`",
            "workflow_launcher.py exec's this file and nothing else starts the "
            "HTTP server; the container comes up serving nothing.",
        )

    _check_main_guard(report, workflow_path, tree)
    _check_stub_imports(report, workflow_path, tree, stub_modules)


def _deploy_names(tree):
    """`(names bound to deploy(), names bound to the deploy module)`."""
    functions, modules = {"deploy"}, set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == "deploy":
            functions.update(
                alias.asname or alias.name
                for alias in node.names
                if alias.name == "deploy"
            )
        elif isinstance(node, ast.Import):
            modules.update(
                alias.asname or alias.name
                for alias in node.names
                if alias.name == "deploy"
            )
    return functions, modules


def _calls_deploy(func, tree):
    """Whether a call's target is deploy(), by any name the workflow gave it."""
    functions, modules = _deploy_names(tree)
    if isinstance(func, ast.Name):
        return func.id in functions
    return (
        isinstance(func, ast.Attribute)
        and func.attr == "deploy"
        and isinstance(func.value, ast.Name)
        and func.value.id in modules
    )


def _check_main_signature(report, workflow_path, main):
    """The platform sends exactly {"query": ...}."""
    if isinstance(main, ast.AsyncFunctionDef):
        report.add(
            "CAR-WORKFLOW-SHAPE",
            workflow_path,
            main.lineno,
            "`main` is `async def`",
            "deploy() calls workflow_fn(**kwargs) on a Flask worker thread with "
            "no await; the response body would be a coroutine repr.",
        )

    params = _parameter_names(main)
    if not params:
        report.add(
            "CAR-WORKFLOW-SHAPE",
            workflow_path,
            main.lineno,
            "`main` takes no arguments",
            'The platform posts {"query": "..."} and deploy() splats the body '
            "in as kwargs -- TypeError on every request.",
        )
        return

    if params[0] != "query":
        report.add(
            "CAR-WORKFLOW-SHAPE",
            workflow_path,
            main.lineno,
            f"`main`'s first parameter is `{params[0]}`, not `query`",
            "The platform's body schema is strictly validated as "
            "{query: string}; any other key is rejected with 400 in the control "
            "plane, before the request reaches the host.",
        )

    extra = [name for name in _required_parameters(main) if name != "query"]
    if extra:
        report.add(
            "CAR-WORKFLOW-SHAPE",
            workflow_path,
            main.lineno,
            f"`main` requires {', '.join(extra)} beyond `query`",
            "Only `query` is ever sent, so every other parameter needs a "
            "default or the call raises on every request. Pack richer input "
            "into `query`.",
        )


def _check_main_guard(report, workflow_path, tree):
    """The launcher exec()s the workflow, so `__name__` IS `__main__` here."""
    for node in tree.body:
        test = node.test if isinstance(node, ast.If) else None
        if (
            isinstance(test, ast.Compare)
            and isinstance(test.left, ast.Name)
            and test.left.id == "__name__"
            and any(
                isinstance(other, ast.Constant) and other.value == "__main__"
                for other in test.comparators
            )
        ):
            report.add(
                "CAR-WORKFLOW-SHAPE",
                workflow_path,
                node.lineno,
                '`if __name__ == "__main__":` block in the workflow',
                "workflow_launcher.py runs exec(open(<workflow>).read()), so "
                "__name__ IS '__main__' here and this block executes in "
                "production, at container start.",
            )
            return


def _check_stub_imports(report, workflow_path, tree, stub_modules):
    """The workflow must reach each agent through the module its stub owns.

    The build writes an agent's stub over its `entrypoint` path and at the
    context root under that path's basename. Those two modules are the whole of
    it: an import that reaches the class through a package re-export or a second
    copy resolves to the real class, and the workflow runs the agent in-process
    with none of the deployment behind it.
    """
    for node in ast.walk(tree):
        if not isinstance(node, ast.ImportFrom) or not node.module:
            continue
        for alias in node.names:
            name = alias.name
            base = name.removesuffix("Stub")
            expected = stub_modules.get(base)
            if expected is None:
                continue
            flat = expected.rsplit(".", 1)[-1]
            if name.endswith("Stub"):
                report.add(
                    "CAR-WORKFLOW-STUB-IMPORT",
                    workflow_path,
                    node.lineno,
                    f"`{name}` is the name the build prints, not the class it writes",
                    "generate_stub sets class_name = agent_config['name'] and "
                    "then recomputes it with a 'Stub' suffix for the log line "
                    "only. The message names a class that does not exist; the "
                    f"class is `{base}`.",
                )
            elif node.module not in (expected, flat):
                report.add(
                    "CAR-WORKFLOW-STUB-IMPORT",
                    workflow_path,
                    node.lineno,
                    f"`from {node.module} import {name}` -- the stub for {name} "
                    f"is written to {expected.replace('.', '/')}.py and to "
                    f"{flat}.py at the context root, nowhere else",
                    "This import reaches the real class instead, and runs the "
                    "agent in this process with none of the deployment behind "
                    f"it. Import it from `{expected}`, where the source already "
                    "keeps it.",
                )


_MISSING_ROOT = (
    f"Every `entrypoint` and `workflow_file` is resolved under `{SOURCE_DIR_NAME}/`, "
    "and the build copies that directory into each image. Without it no service "
    "has any source to run."
)
_MISSING_AGENT = (
    "The build copies this file into the agent's image and the controller loads "
    "the agent class out of it. Without it the agent has no image to build, and "
    "nothing answers for it."
)
_MISSING_WORKFLOW = (
    "The build copies this file into the workflow image and the launcher execs "
    "it to start the HTTP server. Without it the workflow has no image to build, "
    "and the deployment has nothing to serve."
)

_OUTSIDE = (
    "The in-container deploy follows the link and rejects a service whose file "
    "is not in the project, before it builds anything."
)


def _check_entrypoints(report, manifest, source_dir, config_path):
    """Every file the manifest points at is in the source copy."""
    if not os.path.isdir(source_dir):
        report.add(
            "CAR-ENTRYPOINT-MISSING",
            config_path,
            0,
            f"no `{SOURCE_DIR_NAME}/` beside `config/`",
            _MISSING_ROOT,
        )
        return

    for index, service in enumerate(manifest.agents):
        if isinstance(service, AgentService):
            field, declared, mechanism = (
                "entrypoint",
                service.entrypoint,
                _MISSING_AGENT,
            )
        elif isinstance(service, WorkflowService):
            field, declared, mechanism = (
                "workflow_file",
                service.workflow_file,
                _MISSING_WORKFLOW,
            )
        else:
            continue
        # An absent value is the schema's to report, not this check's.
        if not declared:
            continue
        path = os.path.join(source_dir, declared)
        shown = os.path.join(SOURCE_DIR_NAME, declared)
        if not os.path.isfile(path):
            report.add(
                "CAR-ENTRYPOINT-MISSING",
                config_path,
                0,
                f"agents[{index}].{field}: {shown} does not exist",
                mechanism,
            )
        elif not _inside(source_dir, path):
            report.add(
                "CAR-ENTRYPOINT-OUTSIDE",
                config_path,
                0,
                f"agents[{index}].{field}: {shown} resolves outside "
                f"`{SOURCE_DIR_NAME}/`",
                _OUTSIDE,
            )


def _check_flat_collisions(report, source_dir):
    """A project module at the source root the runtime's own copy lands on."""
    for entry in sorted(os.listdir(source_dir)):
        if entry not in _FLAT_MODULES:
            continue
        path = os.path.join(source_dir, entry)
        if not os.path.isfile(path):
            continue
        report.add(
            "CAR-FLAT-COLLISION",
            path,
            1,
            f"a project module named `{entry}` sits at the root of the source copy",
            "The shared CanyonOS Core runtime is copied flat into the image "
            f"after the project sweep, so this file is replaced by Core's own "
            f"{entry}. Rename it or move it into a package directory.",
        )


def _check_package_reexport(report, source_dir, service):
    """The entrypoint's package must not import from the entrypoint itself.

    Python runs a package's `__init__.py` before any of its submodules, and in
    every image except this agent's own the module at the entrypoint is the
    generated stub, which defines the agent class and nothing else.
    """
    package, _, module = _module_path(service.entrypoint).rpartition(".")
    if not package:
        return
    init_path = os.path.join(source_dir, *package.split("."), "__init__.py")
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
            "CAR-PACKAGE-REEXPORT",
            init_path,
            node.lineno,
            f"`{package}/__init__.py` re-exports from `{module}`, the "
            f"entrypoint for {service.name}",
            f"Any peer image that imports anything from `{package}` -- the "
            "workflow importing the agent class included -- re-runs this "
            "re-export against the stub and dies at container startup with "
            f"ImportError. Point `entrypoint` at a module `{package}/"
            "__init__.py` does not re-export from; add one that imports the "
            "real module if every existing module is re-exported.",
        )
        return


# ------------------------------------------------------------------ #
#  Driver                                                              #
# ------------------------------------------------------------------ #


class _Report:
    """The findings so far, with every path written relative to the artifact."""

    def __init__(self, artifact_root):
        self.artifact_root = artifact_root
        self.findings = []

    def add(self, code, path, line, summary, mechanism):
        self.findings.append(
            Finding(code, self.relative(path), line or 0, summary, mechanism)
        )

    def relative(self, path):
        if not path:
            return ""
        try:
            return os.path.relpath(path, self.artifact_root)
        except ValueError:
            # A different drive on Windows: the absolute path is all there is.
            return path


def _declarations(config_dir):
    """Every agent declaration in the config directory, by the name it claims.

    A file that does not parse or does not check out is left out: the schema
    already reported it, and the checks below need a declaration they can trust.
    """
    found = {}
    for path in sorted(glob.glob(os.path.join(config_dir, "*.yaml"))):
        try:
            declaration = load_agent_declaration(path)
        except SchemaError:
            continue
        if declaration.name:
            found[declaration.name] = declaration
    return found


def validate_car(artifact_root, config_path=None):
    """Every violation in a prepared `.car`, schema first, contracts after.

    Never raises: the caller decides how to report. Schema violations come back
    as `CAR-SCHEMA` findings, and when the manifest itself does not parse they
    are all there is -- the rest of the checks have no model to run over.
    """
    artifact_root = os.path.abspath(artifact_root)
    if config_path is None:
        config_path = os.path.join(artifact_root, DEFAULT_CONFIG_PATH)
    elif not os.path.isabs(config_path):
        config_path = os.path.join(artifact_root, config_path)
    config_dir = os.path.dirname(config_path)
    source_dir = os.path.join(artifact_root, SOURCE_DIR_NAME)

    report = _Report(artifact_root)
    for violation in validate_project(config_path, config_dir):
        report.add(
            "CAR-SCHEMA",
            violation.path,
            violation.line,
            f"{violation.field}: {violation.message}"
            if violation.field
            else violation.message,
            "The in-container deploy runs this same check before it generates a "
            "single stub, and rejects the project rather than building it.",
        )

    try:
        manifest = load_manifest(config_path)
    except SchemaError:
        return _sorted(report.findings)

    declarations = _declarations(config_dir)
    _check_entrypoints(report, manifest, source_dir, config_path)
    if not os.path.isdir(source_dir):
        # Already reported, and there is no Python to check without it.
        return _sorted(report.findings)

    stub_modules = {}
    for service in manifest.agents:
        if not isinstance(service, AgentService) or not service.entrypoint:
            continue
        entrypoint_path = os.path.join(source_dir, service.entrypoint)
        if not os.path.isfile(entrypoint_path) or not _inside(
            source_dir, entrypoint_path
        ):
            continue  # reported by _check_entrypoints
        if service.name in declarations:
            stub_modules[service.name] = _module_path(service.entrypoint)
        _check_adapter(
            report, source_dir, entrypoint_path, service, declarations.get(service.name)
        )
        _check_package_reexport(report, source_dir, service)

    for service in manifest.agents:
        if not isinstance(service, WorkflowService) or not service.workflow_file:
            continue
        workflow_path = os.path.join(source_dir, service.workflow_file)
        if os.path.isfile(workflow_path) and _inside(source_dir, workflow_path):
            _check_workflow(report, workflow_path, stub_modules)

    _check_flat_collisions(report, source_dir)
    return _sorted(report.findings)


def _sorted(findings):
    """Grouped by code, then by where they are."""
    return sorted(
        findings, key=lambda finding: (finding.code, finding.path, finding.line)
    )


# ------------------------------------------------------------------ #
#  Entry point                                                         #
# ------------------------------------------------------------------ #


def payload(artifact_root, findings):
    """The JSON object `--json` prints, and the CLI renders from."""
    return {
        "artifact_root": artifact_root,
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
        description="Check a prepared .car against the CanyonOS contract.",
    )
    parser.add_argument(
        "artifact_root",
        nargs="?",
        default=".",
        help="the .car directory holding config/ and app/ (default: the cwd)",
    )
    parser.add_argument(
        "-c",
        "--config",
        default=None,
        help=f"config path relative to artifact_root (default: {DEFAULT_CONFIG_PATH})",
    )
    parser.add_argument("--json", action="store_true", help="emit findings as JSON")
    args = parser.parse_args(argv)

    findings = validate_car(args.artifact_root, args.config)
    if args.json:
        print(json.dumps(payload(os.path.abspath(args.artifact_root), findings)))
    else:
        _print_text(findings)
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
