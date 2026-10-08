# Guides

## Building a workflow

- [Workflow design](WORKFLOW_DESIGN.md): how to think about a workflow, and how to
  start one from scratch or convert an existing one.
- [Limitations](LIMITATIONS.md): what CanyonOS doesn't support yet, and what your
  app needs before porting.
- [Prompt management](PROMPTS.md): viewing and editing agent prompts from the
  dashboard.
- [Autoscaling](SCALING.md): adding and removing agent replicas based on load.
- [Dashboard](DASHBOARD.md): opening the local dashboard, finding a run, and what
  each page shows.
- [CLI reference](CLI.md): every `canyonos` command and what it does.

## Contract reference

These pages describe the contract CanyonOS Core enforces when it builds and
runs a `.car` artifact: the directory shape, the manifest and agent yaml keys,
how containers load and execute your code, what goes into each image, how
model calls are proxied, what EC2 needs, and how to read a failure.

Everything here is traced from the code in `packages/core` and `packages/cli`.
If a page and the code disagree, the code is right. Open an issue or a PR
against the page.

The `porting-to-canyonos` skill in `skills/` is the procedure
`canyonos build` follows to turn an application into a `.car`. It works
against this contract but is not part of it.

### Pages

- [The `.car` artifact](BUILD_ARTIFACT.md): what lives under `.car`, what
  becomes `/app` in the containers, and the names the platform uses.
- [`global_controller.yaml`](GLOBAL_CONTROLLER.md): how to write the deploy file,
  and every key in it and in the agent yaml files, with defaults.
- [Runtime contract](RUNTIME_CONTRACT.md): how agents and workflows are
  loaded, called, stubbed and torn down.
- [Images and dependencies](IMAGES_AND_DEPENDENCIES.md): what Python can
  import from `/app`, what gets installed, and what the build leaves out.
- [LLM gateway](LLM_GATEWAY.md): how OpenAI, Anthropic and Bedrock calls are
  routed through the in-container gateway.
- [EC2 deployment](EC2.md): configuration, networking and cleanup for
  `provider: EC2`.
- [Troubleshooting](TROUBLESHOOTING.md): symptoms and their likely causes,
  by deployment phase.
