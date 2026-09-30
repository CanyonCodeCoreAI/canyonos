# Architectures Folder

Contains the architecture of major systems in CanyonOS.

## How it fits together

Our framework involves creating a global controller that is responsible for managing all config changes, deployment, and any orchestration that happens with your workflow. Running deploy will spawn this controller in the same machine that you run canyonos deploy in.
For each agent being deployed, they all get created with their own local controller, which handles requests being sent in/out of the agent it manages. This controller gets spawned alongside every agent in the same agent container.

## Contents

- [CLI](CLI.md): (packages/cli/)
- [Controller](CONTROLLER.md): (packages/core/canyonos_core/controller/)
- [OTLP Exporter](OTLP_EXPORTER.md): (packages/core/canyonos_core/otlp_exporter/)
- [Reconciler Loop](RECONCILER.md): (packages/core/canyonos_core/reconciler/)
- [LLM Gateway](LLM_GATEWAY.md): (packages/core/canyonos_core/llm_gateway/)
- [Machine Metrics Poller](MACHINE_METRICS_POLLER.md): (packages/core/canyonos_core/machine_metrics_poller/)
