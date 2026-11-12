# Images and dependencies

How CanyonOS builds each agent's image: what it copies and installs, how imports resolve
inside it, and what `canyonos validate` checks first. Read it when an agent fails at
start with an import error or a missing file.

## What `/app` can import

Each image is built on `python:3.11-slim`, copies its build context into `/app`, and
starts there. The agent's controller puts `/app` and `/app/grpc_stubs` on `sys.path`.
Nothing sets `PYTHONPATH` and nothing is installed from your source tree, so every
import resolves from `/app`:

| File in the image      | Imports as                                                    |
| ---------------------- | ------------------------------------------------------------- |
| `/app/tools.py`        | `import tools`                                                |
| `/app/pkg/__init__.py` | `import pkg`                                                  |
| `/app/src/agents/`     | `import src.agents`, including a folder without `__init__.py` |
| `/app/source/pkg/`     | `import source.pkg`, never `import pkg`                       |

The workflow root is the only import root. If your app imports `tools` from a `src/`
folder, make the workflow root a copy of `src/`, not of the repository; each
`entrypoint` is then relative to it. Code that imports both `tools` and `src.tools`
has no single root that serves both.

## What gets installed

Each image installs the platform's base list plus that agent entry's `requirements`,
and nothing else. [Per-image requirements](WORKFLOW_CONFIG.md#per-image-requirements)
lists the base packages, the version caps and the floors the build enforces.

- No image runs `pip install -e .` or reads `pyproject.toml` or your app's
  `requirements.txt`. A `pyproject.toml` in the copy is a plain file and puts nothing
  on `sys.path`.
- After the install, the build runs `uv pip check` and prints a note when packages
  conflict. The build doesn't fail on it.
- The generated `*_pb2.py` modules check the `protobuf` floor when imported, so the
  build forces that floor even past a requirement that asks for less.
- The LLM Gateway runs from its own Python 3.12 environment in the image, so its pins
  never meet yours. It gets `boto3` only when your code can import it.

A wrong PyPI name or a missing distribution fails the image build inside
`canyonos deploy`. `canyonos validate` installs nothing, so it can't catch either.

## What the copy includes

The build context starts as a copy of everything under the workflow root, at its
relative path, Python or not: prompt templates, JSON schemas, PDFs, certificates,
framework YAML files. The container starts at `/app`, so a path your code builds from
the repository root or the working directory still has to land inside the copy.

The copy leaves out:

| Left out                                                                               | Where         | Reported as                                                                                                            |
| -------------------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Hidden files and folders, such as `.streamlit/`                                        | Anywhere      | One `Note:` listing up to 5. Nothing for common names such as `.git`, `.venv`, `.env`, `.vscode` and `*_cache` folders |
| Symlinks, which are never followed                                                     | Anywhere      | One `Note:` listing up to 5                                                                                            |
| `node_modules`, `venv`, `site-packages`, `*.egg-info`                                  | Anywhere      | One `Note:` listing up to 5                                                                                            |
| PEM private keys, found by their `PRIVATE KEY` block, and `.p12`, `.pfx`, `.jks` files | Anywhere      | One `Warning:` per file                                                                                                |
| `Dockerfile`, `requirements.txt`                                                       | Workflow root | One `Warning:` per file                                                                                                |
| `config/`, `stubs/`, `grpc_stubs/`, `docker_container/`                                | Workflow root | Nothing                                                                                                                |
| `__pycache__`, `.pyc`, `.pyo`, `.pyd`                                                  | Anywhere      | Nothing                                                                                                                |

A copy over 100 MB gets a warning naming its largest file.

A file behind one of these rules never reaches the image. Move it out of the hidden
path or `config/`, or copy a symlink's target in. Your code can't read `config/` at run
time; agents get what they need from it through CanyonOS.

A file in the image isn't always one your framework finds. A framework that falls back
to an empty configuration when a YAML file is missing fails later, when the first agent
or task is used, not at import.

## What the build writes on top

After the copy, the build writes these into the context, in this order; later writes
win:

1. The platform's runtime modules, at the root: `future.py`, `canyonos_context.py`,
   `canyonos_governance.py`, `canyonos_health.py`, `gateway_headers.py`,
   `local_controller.py`, `local_controller_frontend.py`, `redis_client.py`,
   `grpc_options.py`, `log_entry.py`, `gpu_metrics.py`, `log_handler.py`,
   `human_input.py` and `canyonos_lazy.py`.
2. Every agent's stub, at its `entrypoint` path and at the root under its basename;
   see [Agent functions and stubs](RUNTIME_CONTRACT.md#agent-functions-and-stubs).
3. The generated `*_pb2.py` and `*_pb2_grpc.py` modules, at the root.
4. `canyonos_core/`, holding only the LLM Gateway and an `__init__.py` that sets
   `__version__`.
5. The agent's own entrypoint, at the root.

A module of yours at the workflow root with one of those names is replaced.
`canyonos validate` reports it as `CANYON-FLAT-COLLISION`.

## What `canyonos validate` checks

`canyonos validate` reads your code and the workflow config. It never builds an image,
installs a package or serves a request. `canyonos deploy` runs the same checks first,
and stops before building anything if they find a problem or can't run.

Unless `canyonos-core` is installed on this machine, `canyonos validate` runs in the
CanyonOS core image, so it needs Docker running here; without it, it exits `2`.

| Code                       | What it checks                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `CANYON-SCHEMA`            | The workflow config's schema, and that every `entrypoint` exists                      |
| `CANYON-ADAPTER-CLASS`     | The entrypoint parses and has a module-level class named after the entry              |
| `CANYON-ADAPTER-INIT`      | The class can be built with no arguments                                              |
| `CANYON-ADAPTER-SIGNATURE` | The class has a method for each of its `functions`, taking the declared arguments     |
| `CANYON-ADAPTER-ASYNC`     | Those methods are not `async def`                                                     |
| `CANYON-PACKAGE-REEXPORT`  | No package `__init__.py` re-exports from an entrypoint that is a stub in other images |
| `CANYON-FLAT-COLLISION`    | No module at the workflow root has the name of a runtime module                       |

| Exit code | Meaning                  |
| --------- | ------------------------ |
| `0`       | No findings              |
| `1`       | Findings, listed above   |
| `2`       | The checks could not run |
