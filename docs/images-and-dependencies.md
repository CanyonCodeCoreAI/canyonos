# Images and dependencies

How the built image resolves imports, what gets installed, and what the copy
of `.car/app` leaves out.

## What `/app` can import

The image copies the build context into `/app`, sets it as the working
directory, and the controller adds `/app` and its `grpc_stubs` to `sys.path`.
Nothing sets `PYTHONPATH` and nothing is installed from the source tree.
Python resolves names rooted at `/app`:

- `/app/tools.py` as `import tools`
- `/app/pkg/__init__.py` as `import pkg`
- `/app/src/agents/` as `import src.agents`, including namespace directories
  without `__init__.py`

`/app/source/pkg` is not `import pkg`. There is exactly one import root, and
it is the top of `.car/app`. If the application imports `tools` from a `src/`
directory, `.car/app` has to be a copy of `src/`, not of the repository, and
`entrypoint` and `workflow_file` are then relative to that. If the source
imports both `tools` and `src.tools`, no single root serves both.

## Packaging metadata is not installed

No image runs `pip install -e .` and none reads `pyproject.toml` or the
application's `requirements.txt`. Both files are swept into the image as
plain files and do nothing there. A `pyproject.toml` added to the copy does
not put a package on `sys.path`.

Each image installs the platform base list plus that entry's `requirements`
from the manifest. See [Per-image
requirements](manifest-reference.md#per-image-requirements) for the base list,
the version caps and the floors the build enforces.

## What the sweep copies

The build context starts as a copy of everything under `.car/app` at its
relative path, Python or not: prompt templates, JSON schemas, PDFs,
certificates, framework yaml files. Because the container starts at `/app`,
a path derived from the original repository root or from the process working
directory has to still land inside the copy.

The sweep leaves out:

- hidden files and directories (anything starting with `.`, so `.env` and
  `.streamlit/` never reach an image)
- symlinks, which are not followed
- `__pycache__`, `.pyc`, `.pyo`, `.pyd`
- `node_modules`, `venv`, `site-packages`, `*.egg-info`
- PEM private keys and `.p12`, `.pfx`, `.jks` files, wherever they are
- at the root of the copy only: `Dockerfile`, `requirements.txt`,
  `workflow_launcher.py`, `stubs/`, `grpc_stubs/`, `docker_container/`

The build prints one `Note:` per category for hidden paths and symlinks with
up to five examples, and one `Warning:` per private key and per reserved name.
Bytecode, the generated directories and common hidden names like `.git` and
`.venv` are dropped silently. A context above 100 MB gets a size warning.

An asset behind one of those rules never reaches the image. Move it out of the
dotted path or symlink, or copy the target in.

After the sweep the build writes on top of it, and later writes win:

- the platform's runtime modules at the context root (`future.py`,
  `canyonos_context.py`, `local_controller.py`, `local_controller_frontend.py`,
  `redis_client.py`, `grpc_options.py`, `log_entry.py`, `gpu_metrics.py`,
  `log_handler.py`, plus `deploy.py` in the workflow image)
- the generated `*_pb2.py` and `*_pb2_grpc.py` modules
- `canyonos_core/`, holding only the LLM proxy and an `__init__.py` that sets
  `__version__`
- every agent's stub, at its entrypoint path and at the root under its
  basename
- the service's own entrypoint (or the workflow file), at the root

A module of your own at the root of the copy with one of those names is
overwritten. `canyonos validate` reports it as `CAR-FLAT-COLLISION`.

Copying a file into the image does not mean the framework finds it.
Frameworks that fall back to an empty configuration when a yaml is missing
fail later, when the first agent or task is used, not at import.

## What `canyonos validate` checks

`canyonos validate` reads `.car` and never builds an image, installs a
package or serves a request. It checks the schema of the manifest and the
declarations (`CAR-SCHEMA`), that every entrypoint exists inside `app/`
(`CAR-ENTRYPOINT-MISSING`, `CAR-ENTRYPOINT-OUTSIDE`), that the entrypoint has
a module-level class named after the entry with a no-argument constructor and
synchronous methods matching the declaration (`CAR-ADAPTER-CLASS`,
`CAR-ADAPTER-INIT`, `CAR-ADAPTER-SIGNATURE`, `CAR-ADAPTER-ASYNC`), that a
package `__init__.py` does not re-export from a stubbed entrypoint
(`CAR-PACKAGE-REEXPORT`), that the workflow file has the expected shape and
imports agents from their declared entrypoints (`CAR-WORKFLOW-SHAPE`,
`CAR-WORKFLOW-STUB-IMPORT`), and the root-name collision above
(`CAR-FLAT-COLLISION`). Exit code 0 means nothing found, 1 means findings,
2 means the check could not run.

Packaging errors, a wrong PyPI name, a missing distribution: those surface in
the image build inside `canyonos deploy`, not here.
