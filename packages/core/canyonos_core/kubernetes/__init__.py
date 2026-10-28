# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""CanyonOS on Kubernetes: what core does only there, in one place.

- `api`: the few Kubernetes API calls core makes, and Kubernetes object names.
- `orchestrator`: `KubernetesOrchestrator`, the Global Controller's orchestrator when
  the operator runs the replicas.
- `run_gc`: the Global Controller alone, as a pod (`canyonos_core.cli run-gc`).
- `manifests`: a project's CanyonProject, CanyonAgents and config ConfigMap.
- `receiver`: a build pod's upload of the project (`canyonos_core.cli receive`).
- `commands`: the `build`, `apply-project`, `receive` and `run-gc` subcommands.

The `kubernetes:` section of `global_controller.yaml` is parsed with every other section,
in schema/kubernetes_block.py: the schema package parses the whole config, so moving
one section here would make the two packages import each other.

Only three modules outside this package import from it: controller/orchestrator.py
(`orchestrator_for` picks `KubernetesOrchestrator`), cli.py (registers `commands`) and
schema/kubernetes_block.py (Kubernetes names); tests/test_kubernetes_boundary.py checks
it. This file imports none of the modules, so using one never loads the others.
"""
