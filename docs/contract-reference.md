# CanyonOS Core contract reference

These pages describe the contract CanyonOS Core enforces when it builds and
runs a `.car` artifact: the directory shape, the manifest and agent yaml keys,
how containers load and execute your code, what goes into each image, how
model calls are proxied, what EC2 needs, and how to read a failure.

Everything here is traced from the code in `packages/core` and `packages/cli`.
If a page and the code disagree, the code is right. Open an issue or a PR
against the page.

The `porting-to-canyonos` skill in `.claude/skills/` is the procedure
`canyonos build` follows to turn an application into a `.car`. It works
against this contract but is not part of it.

## Pages

- [The `.car` artifact](build-artifact.md): what lives under `.car`, what
  becomes `/app` in the containers, and the names the platform uses.
- [Manifest reference](manifest-reference.md): every key in
  `global_controller.yaml` and in the agent yaml files, with defaults.
- [Runtime contract](runtime-contract.md): how agents and workflows are
  loaded, called, stubbed and torn down.
- [Images and dependencies](images-and-dependencies.md): what Python can
  import from `/app`, what gets installed, and what the build leaves out.
- [LLM proxy](llm-proxy.md): how OpenAI, Anthropic and Bedrock calls are
  routed through the in-container proxy.
- [EC2 deployment](ec2.md): configuration, networking and cleanup for
  `provider: EC2`.
- [Troubleshooting](troubleshooting.md): symptoms and their likely causes,
  by deployment phase.
