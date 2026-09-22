# CanyonOS Core contract reference

This is the reference for the contract CanyonOS Core enforces: the `.car`
artifact shape, the manifest and agent-yaml keys, how the runtime loads and
executes a port, image assembly and per-image dependencies, LLM proxy
routing, EC2 deployment, and how to read a failure.

Package READMEs cover developer notes for the code that implements each part
of this contract and link back to the relevant page here. The
`porting-to-canyonos` skill (`.claude/skills/porting-to-canyonos/`) is the
procedure that walks a port through this contract; these pages are the
contract itself, described once instead of copied into the skill's own
reference files.

## Pages

- [build-artifact](build-artifact.md) — `.car` directory shape, what the porter may touch
- [manifest-reference](manifest-reference.md) — `global_controller.yaml` and agent-yaml keys
- [runtime-contract](runtime-contract.md) — adapter/workflow shape, loading, execution, stubs
- [images-and-dependencies](images-and-dependencies.md) — import resolution, packaging, runtime assets
- [llm-proxy](llm-proxy.md) — routing OpenAI, Anthropic, and Bedrock calls through `llm_proxy`
- [ec2](ec2.md) — EC2 provider configuration and networking
- [troubleshooting](troubleshooting.md) — symptom-to-cause tables for a failed deployment

If a page contradicts the code, the code wins — open an issue or PR against
the page rather than trusting it silently.
