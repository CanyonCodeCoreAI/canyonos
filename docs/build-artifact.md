# The `.car` artifact

**Output:** a self-contained `.car/config` and `.car/app`, with the original
application source untouched and existing imports preserved. `.gitignore` and
the environment files are the exception -- see **Artifact boundary**.

## Product and runtime names

CanyonOS Core is the product name and `canyonos` is its user-facing CLI. The
internal Python package, environment variables, and Docker resources are
named `canyonos_core`, `CANYONOS_*`, and `canyonos-*`. These are protocol
identifiers, not CLI instructions or branding strings. Do not rename them.

## Artifact boundary

The port lives entirely inside `.car/`, next to the application source:

```text
.car/config/global_controller.yaml   deployment manifest
.car/config/policy.yaml              optional access restriction
.car/config/<name>.yaml              one callable surface per service
.car/app/                            a copy of the application source
.car/app/<dir>/<name>.py             adapter beside the code it wraps
.car/app/<dir>/<name>_workflow.py    HTTP entry point; calls deploy()
<application source>/                untouched and unaware of the port
```

`.car` has exactly two authored directories: `config/`, which holds every
Canyon-owned declaration, and `app/`, which becomes `/app` in every container.
Nothing under `.car` points back into the original source, and no application
module points at `.car`. Deleting `.car` must restore the project to its
pre-port state, save for three files the port is allowed to touch:

* `.gitignore` -- the artifact preparation step appends `.car/` so the
  artifact stays out of the project's history. That step owns this line; do
  not write it by hand, and do not report it as a source modification.
* `.env` and `.env.example` -- the port's model calls reach the provider
  through the in-container proxy, so its base-URL variables live here. Append
  to `.env` without reading it: it holds the developer's real keys, and a
  later assignment beats an earlier one in both `python-dotenv` and
  `docker --env-file`, so the line you add wins outright. `.env.example`
  carries no secrets; read that one and add only what it lacks. See
  [llm-proxy](llm-proxy.md).

Nothing else outside `.car` changes.

Preserve the source's directory structure. Put adapters in the copied module
whose behavior they wrap unless the entrypoint rules require a sibling module;
do not invent generic `agents/` or `workflow/` directories.

The file count follows the deployment: one yaml/adapter pair per independently
deployed service. If a copied source class already satisfies the runtime
contract, point its declaration at that class and do not add an adapter.

## Source-integrity boundary

The gap validator owns authored runtime contracts that CanyonOS tooling does
not strongly guarantee. The porter owns constraints static analysis cannot
prove:

- Never edit outside `.car`, or duplicate source-owned prompts, tools,
  schemas, model calls, parsing, retries, and node bodies in an adapter. Two
  files at the application root are the deliberate exception, each owned by a
  step that says so: `.gitignore` and the deployment's `.env` /
  `.env.example` (see [llm-proxy](llm-proxy.md)).
- Never swap providers, invent runtime configuration, or silently move, drop,
  or reclassify a dependency.
- Rewrite framework control flow only where it crosses a chosen service
  boundary; preserve it inside a service.
- Never hardcode or bake a real credential into `.car`.
