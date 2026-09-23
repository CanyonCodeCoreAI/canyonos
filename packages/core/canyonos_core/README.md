# CanyonOS Platform

Contract reference: [docs/build-artifact.md](../../../docs/build-artifact.md),
[docs/manifest-reference.md](../../../docs/manifest-reference.md),
[docs/runtime-contract.md](../../../docs/runtime-contract.md),
[docs/images-and-dependencies.md](../../../docs/images-and-dependencies.md).

Every folder in here is a separate process to be run.

- controller: The control plane and manager
- otlp_exporter: The OTel Data Exporter
- server.py: Flask server that CLI connects to
- (soon) Instance_Manager: Responsible for scaling (currently in controller)