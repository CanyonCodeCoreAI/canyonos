#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only
#
# Install (or upgrade) CanyonOS on the kind cluster scripts/kind/up.sh makes, from this
# checkout: the core, api and web images `bun run canyonos:dev` builds, and the
# operator image built here, are pushed to the cluster's registry, then the operator's
# chart is installed with the in-cluster image builder and the dashboard. An image that
# changed rolls out, one that did not restarts nothing. scripts/kind/up.sh runs it
# first, and `bun run canyonos:dev` again after each rebuild while the cluster exists.
# With --version, a published release instead, as a customer installs it: its chart
# and images, from ghcr.
#
# Usage: scripts/kind/operator.sh [--version X.Y.Z]
# Environment:
#   CANYONOS_KIND_CLUSTER  The cluster's name (default canyonos).
# Needs docker, kind and kubectl; helm runs in a container.
set -euo pipefail
# Git Bash on Windows rewrites /... arguments into Windows paths.
export MSYS_NO_PATHCONV=1

CLUSTER_NAME="${CANYONOS_KIND_CLUSTER:-canyonos}"
REGISTRY="localhost:5001"
NAMESPACE="canyonos-system"
# helm 3.17.3, pinned by digest, as the Operator workflow renders the chart with.
HELM_IMAGE="alpine/helm@sha256:d899e6316789fec04ee95300a18e454b7942539cbb3d89bde3e0655d6ca2e895"
RELEASED_CHART="oci://ghcr.io/canyoncodecoreai/charts/canyonos-operator"
# A native path: on Git Bash `pwd -W` gives C:/..., which Docker and kubectl can open.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && { pwd -W 2>/dev/null || pwd; })"

log() { printf '\n== %s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing '$1' on PATH: $2" >&2; exit 1; }; }

release_version() {
  local re='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?(\+[0-9A-Za-z.]+)?$'
  [[ "${1:-}" =~ $re ]] || { echo "--version takes a published release, such as 0.1.739 or 1.0.0-rc1" >&2; exit 2; }
}

version=""
case "${1:-}" in
  "") ;;
  --version) release_version "${2:-}"; version="$2" ;;
  *) echo "Usage: scripts/kind/operator.sh [--version X.Y.Z]" >&2; exit 2 ;;
esac

need docker "install Docker Desktop or Docker Engine"
need kind "https://kind.sigs.k8s.io/docs/user/quick-start/#installation"
need kubectl "https://kubernetes.io/docs/tasks/tools/"
kind get clusters 2>/dev/null | grep -qx "${CLUSTER_NAME}" \
  || { echo "No kind cluster ${CLUSTER_NAME}: run scripts/kind/up.sh first" >&2; exit 1; }
if [ -z "${version}" ]; then
  for name in core api web; do
    docker image inspect "canyonos-${name}:dev" >/dev/null 2>&1 \
      || { echo "No canyonos-${name}:dev image: run \`bun run canyonos:dev\` first, which builds CanyonOS's images from this checkout" >&2; exit 1; }
  done
fi
cluster_kubectl() { kubectl --context "kind-${CLUSTER_NAME}" "$@"; }

kube="$(mktemp -d)"
trap 'rm -rf "${kube}"' EXIT
kind get kubeconfig --internal --name "${CLUSTER_NAME}" > "${kube}/config"
helm() {
  docker run --rm --network kind \
    -v "$(cd "${kube}" && { pwd -W 2>/dev/null || pwd; }):/kube:ro" \
    -v "${REPO}/packages/operator/charts:/charts:ro" \
    -e KUBECONFIG=/kube/config "${HELM_IMAGE}" "$@"
}

# The cluster's own registry: the builder pushes to it over plain HTTP, by the name it
# has inside the kind network.
kind_values=(
  --set builder.enabled=true
  --set "builder.insecureRegistries={kind-registry:5000}"
  --set "builder.registryAliases.localhost:5001=kind-registry:5000"
  --set dashboard.enabled=true
)

if [ -n "${version}" ]; then
  log "CanyonOS ${version}, as published"
  # Helm installs crds/ once and never upgrades them: apply the release's first. The
  # chart's images default to the release's own.
  helm show crds "${RELEASED_CHART}" --version "${version}" \
    | cluster_kubectl apply --server-side --force-conflicts -f - >/dev/null
  helm upgrade --install canyonos "${RELEASED_CHART}" --version "${version}" \
    --namespace "${NAMESPACE}" --create-namespace "${kind_values[@]}" \
    --wait --timeout 10m >/dev/null
  echo "operator, builder and dashboard ${version} installed in ${NAMESPACE}"
  exit 0
fi

log "Image canyonos-operator:dev"
# Only Kubernetes runs the operator, so canyonos:dev leaves it out. Quiet unless the
# build fails; then the end of its own output says why.
out="$(mktemp)"
if ! docker build --progress=plain -f "${REPO}/packages/operator/Dockerfile" \
    -t canyonos-operator:dev "${REPO}/packages/operator" > "${out}" 2>&1; then
  tail -60 "${out}" >&2
  rm -f "${out}"
  exit 1
fi
rm -f "${out}"

# Each image goes to the cluster's registry tagged with its own ID: a rebuild that
# changed it rolls its pods, an unchanged one keeps them, and a node never runs a stale
# copy it cached under the same tag.
pushed() {  # name: the image's reference in the cluster's registry
  local id
  id="$(docker image inspect -f '{{.Id}}' "canyonos-$1:dev")"
  id="${id#sha256:}"
  docker tag "canyonos-$1:dev" "${REGISTRY}/canyonos-$1:${id:0:12}"
  docker push -q "${REGISTRY}/canyonos-$1:${id:0:12}" >/dev/null
  echo "${REGISTRY}/canyonos-$1:${id:0:12}"
}
log "Pushing the images to the cluster's registry"
operator="$(pushed operator)"
core="$(pushed core)"
api="$(pushed api)"
web="$(pushed web)"
printf '%s\n' "${operator}" "${core}" "${api}" "${web}"

log "CanyonOS from this checkout"
# Helm installs crds/ once and never upgrades them: apply them first, taking them over
# from Helm, which installed them.
cluster_kubectl apply --server-side --force-conflicts \
  -f "${REPO}/packages/operator/charts/canyonos-operator/crds/" >/dev/null
helm upgrade --install canyonos /charts/canyonos-operator \
  --namespace "${NAMESPACE}" --create-namespace "${kind_values[@]}" \
  --set image.repository="${operator%:*}" --set image.tag="${operator##*:}" \
  --set controllerImage="${core}" \
  --set dashboard.apiImage="${api}" \
  --set dashboard.webImage="${web}" \
  --wait --timeout 10m >/dev/null
echo "operator, builder and dashboard installed in ${NAMESPACE}"
