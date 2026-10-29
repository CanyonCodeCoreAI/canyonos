#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only
#
# Delete the local CanyonOS kind cluster. The registry container and its images
# are kept unless --all is given.
#
# Usage: scripts/kind/down.sh [--all]
set -euo pipefail
export MSYS_NO_PATHCONV=1

CLUSTER_NAME="${CANYONOS_KIND_CLUSTER:-canyonos}"
REGISTRY_NAME="kind-registry"

kind delete cluster --name "${CLUSTER_NAME}"
if [ "${1:-}" = "--all" ]; then
  docker rm -f "${REGISTRY_NAME}" >/dev/null 2>&1 && echo "Removed registry ${REGISTRY_NAME}" || true
fi
