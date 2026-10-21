# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Stub generator for CanyonOS agents.

Reads the functions an agent declares in `global_controller.yaml` and generates
an importable Python stub file where each function returns a Future object.
Similar in spirit to how gRPC generates *_pb2_grpc.py stub files from .proto
definitions.
"""

import ast
import os
import shutil
import subprocess
from packaging.requirements import InvalidRequirement, Requirement
from packaging.version import InvalidVersion, Version

from canyonos_core.controller.controller_context import _is_local_host
from canyonos_core.controller.utils.container_names import CONTAINER_PORT
from canyonos_core.reconciler import providers

# Lowest versions the image's own code runs on; an app asking for older fails the install.
BASE_AGENT_REQUIREMENTS = [
    "grpcio>=1.76.0",
    "protobuf>=6.31.1",
    "redis>=3.5",
]

# Newest major version of each base package CanyonOS is tested on; installs stay below the next major unless the app asks for newer, which only warns.
TESTED_MAJOR_VERSIONS = {
    "grpcio": 1,
    "protobuf": 6,
    "redis": 8,
}

# The LLM gateway runs from its own venv, so these exact pins never meet the app's.
# These requirements are not pinned to a specific version because LLM-gateway is completely managed by CanyonOS, with no user code interacting with the internals
GATEWAY_REQUIREMENTS = ["flask==3.1.3", "requests==2.34.2", "redis==8.1.0"]

# Only images whose app can import boto3 can call Bedrock, so only they get the gateway's Bedrock route.
GATEWAY_BEDROCK_REQUIREMENT = "boto3==1.43.91"

# Every *_pb2.py checks this floor at import, which no package metadata carries,
# so it is forced past transitive bounds rather than left to the resolver.
PROTOBUF_FLOOR = Requirement(
    next(pin for pin in BASE_AGENT_REQUIREMENTS if pin.startswith("protobuf"))
)

# Mounted only in the build steps that run it, so agent images never carry uv.
UV_IMAGE = "ghcr.io/astral-sh/uv:latest"

IMAGE_PYTHON_VERSION = "3.11"
DEFAULT_DOCKER_PLATFORM = "linux/amd64"

# Runtime modules copied flat into the context root, which `canyonos validate` checks app files against.
_AGENT_FLAT_SOURCES = {
    "future.py": ("controller", "future.py"),
    "canyonos_context.py": ("controller", "canyonos_context.py"),
    "gateway_headers.py": ("controller", "gateway_headers.py"),
    "local_controller.py": ("controller", "local_controller.py"),
    "local_controller_frontend.py": ("controller", "local_controller_frontend.py"),
    "redis_client.py": ("controller", "utils", "redis_client.py"),
    "grpc_options.py": ("controller", "utils", "grpc_options.py"),
    "log_entry.py": ("controller", "utils", "log_entry.py"),
    "gpu_metrics.py": ("controller", "utils", "gpu_metrics.py"),
    "log_handler.py": ("controller", "utils", "log_handler.py"),
}

AGENT_FLAT_MODULES = frozenset(_AGENT_FLAT_SOURCES)


def _build_import_nodes():
    """Build import statements for the generated stub module."""
    return [
        ast.ImportFrom(
            module="future",
            names=[ast.alias(name="Future")],
            level=0,
        ),
        ast.Import(names=[ast.alias(name="inspect")]),
    ]


def _build_stub_method(function, agent_name):
    """
    Build an AST node for a single stub method.

    Given a function config like:
        name: get_stock_price
        arguments:
          - name: ticker
            type: str
        returns:
          type: float

    Generates:
        def get_stock_price(self, ticker: str) -> Future:
            args = {"ticker": ticker}
            return Future(parent=inspect.stack()[1].filename, service="FinanceAgent",
                          method="get_stock_price", args=args, grpc_stub=self.stub)
    """
    func_name = function.name
    arguments = function.arguments

    # Build argument nodes: self + declared args with type annotations
    args_list = [ast.arg(arg="self")]
    for arg in arguments:
        arg_node = ast.arg(
            arg=arg.name,
            annotation=ast.parse(arg.type, mode="eval").body if arg.type else None,
        )
        args_list.append(arg_node)

    func_args = ast.arguments(
        posonlyargs=[],
        args=args_list,
        vararg=None,
        kwonlyargs=[],
        kw_defaults=[],
        kwarg=None,
        defaults=[],
    )

    # Build the function body
    body = []

    arg_dict_keys = [ast.Constant(value=a.name) for a in arguments]
    arg_dict_values = [ast.Name(id=a.name) for a in arguments]

    # args = {"ticker": ticker, ...}
    body.append(
        ast.Assign(
            targets=[ast.Name(id="args")],
            value=ast.Dict(keys=arg_dict_keys, values=arg_dict_values),
            lineno=0,
        )
    )

    # return Future(parent=..., service=..., method=..., args=args)
    body.append(
        ast.Return(
            value=ast.Call(
                func=ast.Name(id="Future"),
                args=[],
                keywords=[
                    ast.keyword(
                        arg="parent",
                        value=ast.Attribute(
                            value=ast.Subscript(
                                value=ast.Call(
                                    func=ast.Attribute(
                                        value=ast.Name(id="inspect"),
                                        attr="stack",
                                    ),
                                    args=[],
                                    keywords=[],
                                ),
                                slice=ast.Constant(value=1),
                            ),
                            attr="filename",
                        ),
                    ),
                    ast.keyword(
                        arg="service",
                        value=ast.Constant(value=agent_name),
                    ),
                    ast.keyword(
                        arg="method",
                        value=ast.Constant(value=func_name),
                    ),
                    ast.keyword(
                        arg="args",
                        value=ast.Name(id="args"),
                    ),
                ],
            ),
        )
    )

    # Build the function def with -> Future return annotation
    func_def = ast.FunctionDef(
        name=func_name,
        args=func_args,
        body=body,
        decorator_list=[],
        returns=ast.Name(id="Future"),
    )

    return func_def


def _build_stub_class(service):
    """
    Build an AST node for the entire stub class.

    Generates a class like:
        class FinanceAgent(object):
            def __init__(self):
                pass
            ...stub methods...
    """
    class_name = service.name
    functions = service.functions

    # __init__ method: simple pass, no gRPC setup needed.
    # Future handles its own gRPC connections via env vars.
    init_method = ast.FunctionDef(
        name="__init__",
        args=ast.arguments(
            posonlyargs=[],
            args=[ast.arg(arg="self")],
            vararg=None,
            kwonlyargs=[],
            kw_defaults=[],
            kwarg=None,
            defaults=[],
        ),
        body=[ast.Pass()],
        decorator_list=[],
        returns=None,
    )

    # Build all stub methods
    methods = [init_method]
    for function in functions:
        methods.append(_build_stub_method(function, service.name))

    class_def = ast.ClassDef(
        name=class_name,
        bases=[ast.Name(id="object")],
        keywords=[],
        body=methods,
        decorator_list=[],
    )

    return class_def


def generate_stub(service, output_path):
    """
    Generate an importable Python stub file for an agent's declared functions.
    """
    class_def = _build_stub_class(service)

    # Build the full module AST
    module = ast.Module(
        body=[
            *_build_import_nodes(),
            class_def,
        ],
        type_ignores=[],
    )

    # Fix missing line numbers required by compile/unparse
    ast.fix_missing_locations(module)

    # Unparse the AST into clean Python source
    source = ast.unparse(module)

    # Use black-style formatting if available, otherwise do basic formatting
    # Add blank lines between methods for readability
    source = _format_source(source)

    # Ensure the output directory exists
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

    with open(output_path, "w") as f:
        f.write(source)

    print(f"Generated stub class '{class_def.name}' -> {output_path}")
    return source


def _format_source(source):
    """Apply basic formatting to make the generated source more readable."""
    lines = source.split("\n")
    formatted = []
    for i, line in enumerate(lines):
        formatted.append(line)
        # Add blank line after import statements
        if line.startswith("from ") or line.startswith("import "):
            formatted.append("")
        # Add blank line before method definitions (except first in class)
        if i + 1 < len(lines) and lines[i + 1].strip().startswith("def "):
            if not line.strip().startswith("class "):
                formatted.append("")

    return "\n".join(formatted) + "\n"


# What the sweep leaves out. These lists are hardcoded with no project override
# because the build context is assembled by hand, so Docker's own ignore
# mechanism never gets to run.

# Directories canyonos build itself generates inside a project -- never swept.
_GENERATED_DIRS = {"docker_container", "stubs", "grpc_stubs"}

# A macOS virtualenv or cache is dead weight in a linux image, at best.
_SKIPPED_DIRS = {"__pycache__", "node_modules", "venv", "site-packages"}

# The generator writes these into the context itself, requirements.txt before
# the copy runs -- a project file of the same name at the root would win.
RESERVED_CONTEXT_NAMES = frozenset(
    {
        "Dockerfile",
        "requirements.txt",
    }
)

_SKIPPED_SUFFIXES = (".pyc", ".pyo", ".pyd")

# Binary keystores carry no armor to detect them by.
_KEYSTORE_SUFFIXES = (".p12", ".pfx", ".jks")

# Enough to see PEM armor past any header the tool that wrote it left.
_KEY_ARMOR_SCAN_BYTES = 4096

# Past this, say so: usually a dataset, a checkpoint, or a virtualenv under a
# name _SKIPPED_DIRS does not know.
_LARGE_CONTEXT_BYTES = 100 * 1024 * 1024

# Hidden paths every repo has: held back like all hidden paths, but not announced on
# every build, since a note that always fires buries the one that matters.
_UNREMARKABLE_HIDDEN = {
    ".git",
    ".gitignore",
    ".gitattributes",
    ".gitmodules",
    ".dockerignore",
    ".editorconfig",
    ".python-version",
    ".venv",
    ".idea",
    ".vscode",
    ".DS_Store",
}


def _is_unremarkable_hidden(name):
    """Whether this hidden path is the tooling furniture every repo has, rather than project content."""
    return name in _UNREMARKABLE_HIDDEN or name.endswith("_cache")


def _looks_like_private_key(path, fname):
    """Whether this file is private key material that must not be baked into an image.

    Matching on names is theater -- an OpenSSH key is called `id_rsa`, with no
    extension at all -- so PEM material is found by its armor instead. A
    certificate is public and ships; only a PRIVATE KEY block is held back.

    Not a secret scanner: `credentials.json` still ships, because nothing can
    recognize it. Credentials belong in the container environment either way.
    """
    if fname.endswith(_KEYSTORE_SUFFIXES):
        return True
    try:
        with open(path, "rb") as handle:
            head = handle.read(_KEY_ARMOR_SCAN_BYTES)
    except OSError:
        return False
    return b"-----BEGIN" in head and b"PRIVATE KEY-----" in head


def _format_path_sample(paths, limit=5):
    """One line naming up to `limit` of these paths, with a count standing in for the rest."""
    shown = ", ".join(sorted(paths)[:limit])
    if len(paths) > limit:
        shown += f", (+{len(paths) - limit} more)"
    return shown


def _sweep_project_files(project_dir, exclude_dir=None):
    """Recursively collect (abs_src, rel_dst) for every project file under project_dir, preserving its directory structure.

    Not only .py: source opens PDFs, prompts, and framework config at runtime,
    and a file missing from the image fails only once the agent is serving.

    Symlinks are never followed. A link to /etc or to a home directory would
    copy files from outside the project into the image, so both the file and the
    directory case are pruned here rather than left to `os.walk` defaulting to
    `followlinks=False` -- a security property should not rest on a default
    someone can flip.

    Every exclusion is reported except the ones that could never have held
    shippable content -- __pycache__, bytecode, and the build's own output. A
    file that silently fails to arrive is the bug this sweep exists to fix, so
    dropping one quietly just moves it somewhere harder to find.

    `exclude_dir` is the build context being assembled, which sits under the
    project root. Matching it by resolved path rather than name is what keeps
    this working for a caller that picks an output directory outside
    `_GENERATED_DIRS`.
    """
    swept = []
    hidden = []
    symlinks = []
    host_local = []
    private_keys = []
    reserved = []
    total_bytes = 0
    largest = (0, None)
    context_dir = os.path.realpath(exclude_dir) if exclude_dir else None

    for root, dirs, files in os.walk(project_dir):
        at_root = root == project_dir

        kept_dirs = []
        for name in dirs:
            abs_dir = os.path.join(root, name)
            if context_dir and os.path.realpath(abs_dir) == context_dir:
                continue
            rel_dir = os.path.relpath(abs_dir, project_dir) + os.sep
            if os.path.islink(abs_dir):
                symlinks.append(rel_dir)
            elif name.startswith("."):
                if not _is_unremarkable_hidden(name):
                    hidden.append(rel_dir)
            elif name in _SKIPPED_DIRS or name.endswith(".egg-info"):
                if name != "__pycache__":
                    host_local.append(rel_dir)
            elif not (at_root and name in _GENERATED_DIRS):
                kept_dirs.append(name)
        dirs[:] = kept_dirs

        for fname in files:
            abs_src = os.path.join(root, fname)
            rel_dst = os.path.relpath(abs_src, project_dir)
            if fname.startswith("."):
                if not _is_unremarkable_hidden(fname):
                    hidden.append(rel_dst)
                continue
            if os.path.islink(abs_src):
                symlinks.append(rel_dst)
                continue
            if fname.endswith(_SKIPPED_SUFFIXES):
                continue
            if _looks_like_private_key(abs_src, fname):
                private_keys.append(rel_dst)
                continue
            if at_root and fname in RESERVED_CONTEXT_NAMES:
                reserved.append(rel_dst)
                continue
            swept.append((abs_src, rel_dst))
            try:
                size = os.path.getsize(abs_src)
            except OSError:
                size = 0
            total_bytes += size
            if size > largest[0]:
                largest = (size, rel_dst)

    if hidden:
        print(
            f"  Note: {len(hidden)} hidden path(s) not copied into the image: "
            f"{_format_path_sample(hidden)}. Move anything the agent opens at runtime out of "
            f"a dotted path."
        )
    if symlinks:
        print(
            f"  Note: {len(symlinks)} symlink(s) not followed into the image: "
            f"{_format_path_sample(symlinks)}. Copy the target in if the agent needs it."
        )
    if host_local:
        print(
            f"  Note: {len(host_local)} host-local path(s) not copied into the image: "
            f"{_format_path_sample(host_local)}. The image installs its own dependencies."
        )
    for rel_dst in sorted(private_keys):
        print(f"  Warning: not copying private key material into the image: {rel_dst}")
    for rel_dst in sorted(reserved):
        print(
            f"  Warning: the build context owns '{os.path.basename(rel_dst)}', so the "
            f"project's own copy is not included in the image"
        )
    if total_bytes > _LARGE_CONTEXT_BYTES:
        print(
            f"  Warning: sweeping {total_bytes // (1024 * 1024)} MB into this image, "
            f"largest is {largest[1]} at {largest[0] // (1024 * 1024)} MB. Everything "
            f"under the project root ships unless it is hidden or generated."
        )

    return swept


def _stub_destination(stub_file, stub_entrypoints):
    """Where to copy a stub so it overwrites the real file it replaces.

    Raises if the stub cannot be placed there; there is no flat fallback.
    """
    basename = os.path.basename(stub_file)
    entrypoint = stub_entrypoints.get(basename)
    if not entrypoint:
        raise ValueError(
            f"no entrypoint mapping for stub {basename}; known stubs: "
            f"{sorted(stub_entrypoints) or 'none'}. The stub must overwrite the "
            "agent's module in every other image."
        )
    normalized = entrypoint.replace("\\", "/")
    if normalized.startswith("/") or ".." in normalized.split("/"):
        raise ValueError(
            f"unsafe entrypoint '{entrypoint}' for stub {basename}: it must be a "
            "relative path inside the image."
        )
    return normalized


def _copy_llm_gateway(output_dir, script_dir):
    """Copy the canyonos_core.llm_gateway package into the build context as an importable
    `canyonos_core` package so the in-container gateway can run via `python -m canyonos_core.llm_gateway`."""
    shutil.copytree(
        os.path.join(script_dir, "llm_gateway"),
        os.path.join(output_dir, "canyonos_core", "llm_gateway"),
        dirs_exist_ok=True,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
    )
    shutil.copy2(
        os.path.join(script_dir, "__init__.py"),
        os.path.join(output_dir, "canyonos_core", "__init__.py"),
    )


def _copy_files(output_dir, files_to_copy):
    """Copy each (src, dst) pair into output_dir, refusing to write outside it (e.g. via a symlinked destination parent)."""
    real_output_dir = os.path.realpath(output_dir)
    for src, dst in files_to_copy:
        if not os.path.isfile(src):
            print(f"  Warning: source file not found, skipping: {src}")
            continue
        dest_path = os.path.join(output_dir, dst)
        real_dest = os.path.realpath(dest_path)
        if os.path.commonpath([real_output_dir, real_dest]) != real_output_dir:
            print(f"  Warning: destination escapes build context, skipping: {dst}")
            continue
        os.makedirs(os.path.dirname(dest_path), exist_ok=True)
        shutil.copy2(src, dest_path)


# Bandage: revisit once resources are pooled and agents no longer declare a provider.
def target_docker_platform(agents):
    """Return the platform `canyonos deploy` builds and pulls every image for:
    `CANYONOS_DOCKER_PLATFORM` when set, else this Docker daemon's own when every
    agent runs on this machine, else the portable one EC2 and remote hosts run."""
    explicit = os.environ.get("CANYONOS_DOCKER_PLATFORM")
    if explicit:
        return explicit
    # port_claim_host gives the host an agent runs on, or None if it gets its own machine.
    if all(
        _is_local_host(
            providers.get(agent.get("provider", providers.DEFAULT)).port_claim_host(
                agent
            )
        )
        for agent in agents
    ):
        return _docker_daemon_platform()
    return DEFAULT_DOCKER_PLATFORM


def _docker_daemon_platform():
    """Ask the Docker daemon this deploy builds on for its platform, e.g. `linux/arm64`.
    Raise with Docker's own message when it cannot answer, so the deploy shows it."""
    try:
        result = subprocess.run(
            ["docker", "version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"],
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as error:
        raise RuntimeError(
            "Cannot find the `docker` command to ask which platform to build for."
        ) from error
    if result.returncode != 0:
        raise RuntimeError(
            "Docker could not say which platform to build for: "
            f"{result.stderr.strip() or result.stdout.strip()}"
        )
    return result.stdout.strip()


def _platform_overrides(requirements):
    """Defines the range of versions protobuf can take."""
    specifier = PROTOBUF_FLOOR.specifier
    for requirement in requirements:
        try:
            parsed = Requirement(requirement)
        except InvalidRequirement:
            continue
        if parsed.name.lower() == PROTOBUF_FLOOR.name:
            specifier &= parsed.specifier
    return [f"{PROTOBUF_FLOOR.name}{specifier}"]


def _below_supported_version(spec, floor):
    """Checks if a version specified in an agents requirements list is below the minimum required version CanyonOS requires."""
    try:
        if spec.operator == "==" and spec.version.endswith(".*"):
            release = Version(spec.version[:-2]).release
            return (
                Version(".".join(map(str, (*release[:-1], release[-1] + 1)))) <= floor
            )
        version = Version(spec.version)
    except InvalidVersion:
        return False
    if spec.operator in ("==", "==="):
        return version < floor
    if spec.operator == "<":
        return version <= floor
    if spec.operator == "<=":
        return version < floor
    if spec.operator == "~=":
        release = version.release
        return Version(".".join(map(str, (*release[:-2], release[-2] + 1)))) <= floor
    return False


def too_old_requirements(requirements):
    """Return (requirement, our_floor) for each requirement that only allows versions older than CanyonOS supports."""
    floors = {}
    for base in BASE_AGENT_REQUIREMENTS:
        parsed = Requirement(base)
        floors[parsed.name] = (Version(next(iter(parsed.specifier)).version), base)
    unsupported = []
    for requirement in requirements:
        try:
            parsed = Requirement(requirement)
        except InvalidRequirement:
            continue
        floor = floors.get(parsed.name.lower())
        if floor and any(
            _below_supported_version(spec, floor[0]) for spec in parsed.specifier
        ):
            unsupported.append((requirement, floor[1]))
    return unsupported


def _above_tested_version(spec, limit):
    """Checks if a version specified in an agents requirements list is above the newest version CanyonOS has tested."""
    try:
        if spec.operator == "==" and spec.version.endswith(".*"):
            return Version(spec.version[:-2]) >= limit
        version = Version(spec.version)
    except InvalidVersion:
        return False
    return spec.operator in ("==", "===", ">=", ">", "~=") and version >= limit


def too_new_requirements(requirements):
    """Return (requirement, tested_limit) for each requirement that only allows versions newer than CanyonOS has tested."""
    limits = {
        name: Version(str(major + 1)) for name, major in TESTED_MAJOR_VERSIONS.items()
    }
    too_new = []
    for requirement in requirements:
        try:
            parsed = Requirement(requirement)
        except InvalidRequirement:
            continue
        limit = limits.get(parsed.name.lower())
        if limit and any(
            _above_tested_version(spec, limit) for spec in parsed.specifier
        ):
            too_new.append((requirement, f"{parsed.name.lower()}<{limit}"))
    return too_new


def _dockerfile_install_steps(overrides, requirements):
    """Writes the Dockerfile steps that install the agent's packages, capped at the versions CanyonOS has tested, plus the LLM gateway's own separate packages."""
    forced = " ".join(f"'{override}'" for override in overrides)
    asked_newer = {
        Requirement(requirement).name.lower()
        for requirement, _ in too_new_requirements(requirements)
    }
    caps = " ".join(
        f"'{name}<{major + 1}'"
        for name, major in TESTED_MAJOR_VERSIONS.items()
        if name not in asked_newer
    )
    return f"""ENV UV_COMPILE_BYTECODE=1
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/uv --mount=from={UV_IMAGE},source=/uv,target=/bin/uv printf '%s\\n' {forced} > /tmp/overrides.txt \\
 && printf '%s\\n' {caps} > /tmp/tested.txt \\
 && uv pip install --system -r requirements.txt --overrides /tmp/overrides.txt -c /tmp/tested.txt
RUN --mount=from={UV_IMAGE},source=/uv,target=/bin/uv uv pip check --system || echo "NOTE: CanyonOS forces {forced}; an incompatibility above naming one of those is a bound it could not share with the app."
RUN --mount=type=cache,target=/root/.cache/uv --mount=from={UV_IMAGE},source=/uv,target=/bin/uv uv venv /opt/canyonos-gateway \\
 && uv pip install --python /opt/canyonos-gateway/bin/python {" ".join(GATEWAY_REQUIREMENTS)} \\
 && if python -c "import boto3" 2>/dev/null; then uv pip install --python /opt/canyonos-gateway/bin/python {GATEWAY_BEDROCK_REQUIREMENT}; fi
"""


def generate_docker(
    agent_name,
    agent_file,
    output_dir=None,
    grpc_stubs_dir=None,
    stub_files=None,
    project_dir=None,
    stub_entrypoints=None,
    requirements=None,
):
    """
    Generate a minimal Docker build context for an agent.

    Creates a directory containing a Dockerfile, requirements.txt, and all
    source files needed to run the agent with its own local controller.

    Args:
        agent_name:        The agent's class name, as its manifest entry names it.
        agent_file:        Path to the original Python agent implementation.
        output_dir:        Optional output directory (default: docker_container/<AgentName>/).
        grpc_stubs_dir:    Optional path to compiled gRPC stubs (default: <repo_root>/grpc_stubs).
        stub_files:        Optional list of agent stub files to copy into the context.
        project_dir:       Optional project root whose files are swept into the context.
        stub_entrypoints:  Optional {stub_basename: entrypoint} map for exact stub placement.
        requirements:   Optional list of extra pip packages this agent needs.
    """
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.join(script_dir, "..")

    if output_dir is None:
        output_dir = os.path.join(project_root, "docker_container", agent_name)

    if grpc_stubs_dir is None:
        grpc_stubs_dir = os.path.join(project_root, "grpc_stubs")

    os.makedirs(output_dir, exist_ok=True)

    # ---- requirements.txt ------------------------------------------------
    # Base packages the shared framework files need, plus this agent's own.
    overrides = _platform_overrides(requirements or [])
    requirements_txt = (
        "\n".join(BASE_AGENT_REQUIREMENTS + list(requirements or [])) + "\n"
    )
    with open(os.path.join(output_dir, "requirements.txt"), "w") as f:
        f.write(requirements_txt)

    # Sweep the whole project first; the explicit list below is copied on top.
    files_to_copy = []
    if project_dir:
        files_to_copy += _sweep_project_files(project_dir, exclude_dir=output_dir)

    # Copy general agent files
    files_to_copy += [
        (os.path.join(script_dir, *parts), destination)
        for destination, parts in _AGENT_FLAT_SOURCES.items()
    ]

    # Copy provided agent stubs both flat (for `from price_agent import ...` style
    # peer imports) and at their entrypoint-mirrored path (overwriting the swept
    # real agent file there, as before), so both import styles resolve.
    if stub_files:
        for stub_file in stub_files:
            flat_dest = os.path.basename(stub_file)
            entrypoint_dest = _stub_destination(stub_file, stub_entrypoints or {})
            files_to_copy.append((os.path.abspath(stub_file), flat_dest))
            if entrypoint_dest != flat_dest:
                files_to_copy.append((os.path.abspath(stub_file), entrypoint_dest))

    # Copy gRPC generated stubs if they exist
    if os.path.isdir(grpc_stubs_dir):
        for fname in os.listdir(grpc_stubs_dir):
            if fname.endswith(".py"):
                files_to_copy.append((os.path.join(grpc_stubs_dir, fname), fname))

    _copy_files(output_dir, files_to_copy)
    _copy_llm_gateway(output_dir, script_dir)

    # Copy the real agent entrypoint to the context root (after _copy_files so it
    # wins over any swept copy of the same file from the project directory).
    shutil.copy2(
        os.path.abspath(agent_file),
        os.path.join(output_dir, os.path.basename(agent_file)),
    )

    # ---- Dockerfile ------------------------------------------------------
    agent_basename = os.path.basename(agent_file)
    dockerfile = f"""# syntax=docker/dockerfile:1
FROM python:{IMAGE_PYTHON_VERSION}-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1

{_dockerfile_install_steps(overrides, requirements or [])}
COPY . .

ENV CANYONOS_AGENT_NAME={agent_name}
ENV CANYONOS_AGENT_FILE={agent_basename}

EXPOSE {CONTAINER_PORT}

CMD ["python", "local_controller.py", "--port", "{CONTAINER_PORT}"]
"""
    with open(os.path.join(output_dir, "Dockerfile"), "w") as f:
        f.write(dockerfile)

    print(f"Generated Docker context for '{agent_name}' -> {output_dir}")
    return output_dir
