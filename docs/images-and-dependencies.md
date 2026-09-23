# Images and dependencies

How the built image resolves imports, what packaging metadata does and does
not do, and what the runtime image sweep does and does not carry.

## What `/app` can import

CanyonOS Core copies `.car/app/` into the image with its paths intact and
starts Python at `/app`, so `/app` is that copy. Python resolves names rooted
there:

- `/app/tools.py` as `import tools`
- `/app/pkg/__init__.py` as `import pkg`
- `/app/src/agents/...` as `import src.agents`, including PEP 420 namespace
  directories without `__init__.py`

It does not resolve `/app/source/pkg` as `import pkg`; `/app/source` must
become an import root first.

### Re-root the copy before reaching for metadata

`.car/app/` is a copy Canyon owns, so the cheapest fix is usually to root it
where the source already imports from. A project laid out as

```text
repo/src/email_assistant.py     imports `tools`, `prompts`, `utils`
repo/src/tools/
repo/pyproject.toml
```

has `src/` as its import root. Copy `src/`'s contents to `.car/app/` and every
one of those imports resolves from `/app` with no metadata, no editable
install and no `sys.path` hack. `entrypoint` and `workflow_file` then name
modules relative to that root, and the workflow imports the agent the same
way.

One copy root has to serve every import. When none can -- the source imports
both `tools` and `src.tools` -- no packaging trick closes the gap; report the
blocker and stop.

## Packaging metadata is never installed

No image runs `pip install -e .`, under any provider, so a `pyproject.toml` in
the copy installs nothing and puts no package on `sys.path`. Do not author a
wrapper one to reach a nested import, and do not substitute a `sys.path` hack
or relocated source files: re-root the copy, or report the blocker.

Keep the source's own declaration unchanged and repeat its runtime
distributions in each relevant config entry's `requirements`, the only list an
image installs -- see [manifest-reference](manifest-reference.md#per-image-requirements).
This is compatibility scaffolding, not permission to drop, move, or reclassify
declared dependencies. Report declared-but-unused toolchain dependencies and
their image cost; let the owner decide whether source metadata should change.

## Runtime data and configuration files

The build copies non-Python files into `.car/app`, but that does not prove
the runtime's image sweep carries them into a container. Inventory every file
opened by the selected import graph: prompt templates, JSON schemas, PDFs,
local corpora, certificates, and framework configuration such as CrewAI
`agents.yaml` and `tasks.yaml`.

The image sweep carries every file, so retain each asset at the same path
relative to the chosen import root, and check any path derived from the
original repository root or the process working directory; the container
starts at `/app`.

What the sweep holds back is a class of path rather than a file type: hidden
paths, symlinks, private key material, and the names the build context owns.
An asset behind one of those never reaches the image -- move it out of the
dotted path, or report it as a runtime blocker and stop after validation. Do
not conceal the gap by base64-encoding the file into Python, changing a
hardcoded path, or duplicating framework config into adapter code; those
changes restate source-owned data and behavior.

Do not treat successful construction as evidence that configuration loaded.
Frameworks such as CrewAI may warn about a missing yaml and create an empty
configuration, then fail only when the first agent or task is accessed.

## Validation boundary

The build phase of `canyonos deploy` owns packaging syntax and installation
errors. Pre-deploy validation checks only whether adapter imports appear to
require a nested root that the runtime will not expose.
