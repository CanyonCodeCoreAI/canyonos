#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only
#
# Installing, upgrading and removing the operator's chart as a cluster's administrator
# does, on a kind cluster `scripts/kind/up.sh --no-operator` made (no CanyonOS on it
# yet). It checks that:
#   - with crds.enabled=false and no CanyonOS CRDs in the cluster, the install is
#     refused, saying why, and nothing is installed;
#   - a cluster running the last release that kept its CRDs in the chart's crds/
#     folder (outside the Helm release) upgrades to this checkout as the Kubernetes
#     guide says, with --reset-then-reuse-values, plus --take-ownership: the CRDs
#     join the release, kept by Helm, and the project on them stays;
#   - a chart whose CRD adds a field brings it with `helm upgrade` alone, and the
#     project's pods keep running;
#   - `helm rollback`, then `helm uninstall`, leave the CRDs, the project and its pods;
#   - installing again takes the project back;
#   - a second install, in another namespace, is refused, saying why, before anything
#     is applied.
# The project is a CanyonProject alone, with no config or agents: the operator still
# runs its Redis, whose pod shows whether the project kept running.
# It leaves this checkout's CanyonOS installed, as scripts/kind/operator.sh does, so
# scripts/kind/e2e.sh can run next.
#
# Usage: scripts/kind/chart-e2e.sh
# Environment:
#   CANYONOS_KIND_CLUSTER     The cluster's name (default canyonos).
#   CANYONOS_CHART_E2E_FROM   The published release to upgrade from (default 0.2.2).
# Needs docker, kind, kubectl and bun; helm runs in a container.
set -euo pipefail
# Git Bash on Windows rewrites /... arguments into Windows paths.
export MSYS_NO_PATHCONV=1

CLUSTER_NAME="${CANYONOS_KIND_CLUSTER:-canyonos}"
FROM="${CANYONOS_CHART_E2E_FROM:-0.2.2}"
NAMESPACE="canyonos-system"
NS="canyonos-chart-e2e"
SECOND_NS="canyonos-chart-e2e-second"
CRDS=(canyonprojects.canyonos.canyoncode.ai canyonagents.canyonos.canyoncode.ai
  canyonbuilds.canyonos.canyoncode.ai)
# helm 3.17.3, pinned by digest, as scripts/kind/operator.sh runs it.
HELM_IMAGE="alpine/helm@sha256:d899e6316789fec04ee95300a18e454b7942539cbb3d89bde3e0655d6ca2e895"
# The chart refuses to install without the API's key (dashboard.apiKeyHash): the
# refusals below pass one, so only the check each is for can refuse.
KEY="dashboard.apiKeyHash=0000000000000000000000000000000000000000000000000000000000000000"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"

log() { printf '\n== %s\n' "$*"; }
k() { kubectl --context "kind-${CLUSTER_NAME}" "$@"; }
fail() {
  echo "FAIL: $*" >&2
  k get pods -A -o wide >&2 || true
  k -n "${NAMESPACE}" logs deploy/canyonos-controller-manager --tail=40 >&2 || true
  exit 1
}
operator() { CANYONOS_KIND_CLUSTER="${CLUSTER_NAME}" "${HERE}/operator.sh" "$@"; }

command -v kind >/dev/null || { echo "Missing 'kind' on PATH" >&2; exit 1; }
command -v bun >/dev/null || { echo "Missing 'bun' on PATH: it builds the images (bun run canyonos:dev)" >&2; exit 1; }
kind get clusters 2>/dev/null | grep -qx "${CLUSTER_NAME}" \
  || { echo "No kind cluster ${CLUSTER_NAME}: run scripts/kind/up.sh --no-operator" >&2; exit 1; }

# This checkout's chart (/kube/chart), and a copy whose CRD the test changes (/kube/probe).
kube="$(mktemp -d)"
trap 'rm -rf "${kube}"' EXIT
kind get kubeconfig --internal --name "${CLUSTER_NAME}" > "${kube}/config"
mkdir "${kube}/chart" "${kube}/probe"
cp -r "${REPO}/packages/operator/charts/canyonos-operator" "${kube}/chart/"
cp -r "${REPO}/packages/operator/charts/canyonos-operator" "${kube}/probe/"
helm() {
  docker run --rm --network kind \
    -v "$(cd "${kube}" && { pwd -W 2>/dev/null || pwd; }):/kube" \
    -e KUBECONFIG=/kube/config "${HELM_IMAGE}" "$@"
}

project_uid() { k -n "${NS}" get canyonproject chart-e2e -o jsonpath='{.metadata.uid}'; }
redis_ready() { k -n "${NS}" get canyonproject chart-e2e -o jsonpath='{.status.conditions[?(@.type=="RedisReady")].status}'; }
redis_pod() {  # the project's Redis pod: its UID and whether it is ready
  k -n "${NS}" get pod canyonos-redis-0 -o jsonpath='{.metadata.uid} {.status.containerStatuses[0].ready}' 2>/dev/null || true
}
until_redis_ready() {  # what for: the pod's UID once ready, and the project says so
  for _ in $(seq 150); do
    case "$(redis_pod)" in
      *" true") [ "$(redis_ready)" = True ] && { redis_pod | cut -d' ' -f1; return 0; } ;;
    esac
    sleep 2
  done
  fail "$1: the project's Redis is not ready ($(redis_pod), RedisReady $(redis_ready))"
}
same_project() {  # what: the project and its Redis pod are the ones from before
  [ "$(project_uid)" = "${uid}" ] || fail "$1: the CanyonProject is gone or was made again"
  [ "$(redis_pod)" = "${pod} true" ] || fail "$1: the project's Redis pod was replaced or is not ready ($(redis_pod))"
}

log "A cluster with no CanyonOS on it"
if k get crd "${CRDS[0]}" >/dev/null 2>&1 || helm status canyonos -n "${NAMESPACE}" >/dev/null 2>&1; then
  echo "CanyonOS is on ${CLUSTER_NAME} already: this test starts without it (scripts/kind/down.sh, then scripts/kind/up.sh --no-operator)" >&2
  exit 1
fi

log "crds.enabled=false with no CRDs in the cluster: refused"
said="$(helm install canyonos /kube/chart/canyonos-operator --namespace "${NAMESPACE}" \
  --create-namespace --set crds.enabled=false --set "${KEY}" 2>&1)" && fail "installed with no CRDs: ${said}"
echo "${said}" | grep -q "crds.enabled is false, but the cluster has no CRD" \
  || fail "refused without saying why: ${said}"
helm status canyonos -n "${NAMESPACE}" >/dev/null 2>&1 && fail "the refused install left a release"
echo "refused: ${said}"

log "CanyonOS ${FROM}, as published, and a project on it"
operator --version "${FROM}"
k create namespace "${NS}" >/dev/null
project() {  # endpoint: the project's endpoint, as the installed CRD takes it
  k apply -f - >/dev/null <<EOF
apiVersion: canyonos.canyoncode.ai/v1alpha1
kind: CanyonProject
metadata: {name: chart-e2e, namespace: ${NS}}
spec:
  projectID: 0000c4a2-7e2e-4000-8000-000000000001
  configRef: chart-e2e
  endpoint: $1
EOF
}
# A list of routes; releases up to 0.2.x took one agent and method instead.
project "{routes: [{agent: chart-e2e, method: main}]}" 2>/dev/null \
  || project "{agent: chart-e2e, method: main}" \
  || fail "the ${FROM} CRD takes neither endpoint"
uid="$(project_uid)"
until_redis_ready "on ${FROM}" >/dev/null

log "Upgrading to this checkout as the guide says (--reset-then-reuse-values), with --take-ownership"
(cd "${REPO}" && bun run canyonos:dev --images-only)
CANYONOS_KIND_REUSE_VALUES=1 operator
for crd in "${CRDS[@]}"; do
  owner="$(k get crd "${crd}" -o jsonpath='{.metadata.annotations.meta\.helm\.sh/release-name}/{.metadata.annotations.meta\.helm\.sh/release-namespace}/{.metadata.annotations.helm\.sh/resource-policy}')"
  [ "${owner}" = "canyonos/${NAMESPACE}/keep" ] || fail "CRD ${crd} is not the release's, kept: ${owner}"
done
[ "$(project_uid)" = "${uid}" ] || fail "the upgrade lost the CanyonProject"
pod="$(until_redis_ready "after the upgrade")"
# --reset-then-reuse-values keeps only the settings the release was given: a default
# this chart changed, such as the builder's image, replaces the earlier release's.
want="$(awk '/^builder:/{b=1} b&&/^  image:/{print $2; exit}' "${REPO}/packages/operator/charts/canyonos-operator/values.yaml")"
got="$(k -n canyonos-build get deploy buildkitd -o jsonpath='{.spec.template.spec.containers[0].image}')"
[ "${got}" = "${want}" ] || fail "the upgrade kept the builder image ${got}, not this chart's ${want}"
echo "the CRDs are the release's, kept by Helm; the project stayed; the builder runs ${got}"

log "A chart whose CRD adds a field: helm upgrade alone brings it"
probe='{"spec":{"chartE2eProbe":"kept"}}'
probe_kept() {  # the field as the API server keeps it from the patch: dropped when unknown
  k -n "${NS}" patch canyonproject chart-e2e --type merge -p "${probe}" "$@" \
    -o jsonpath='{.spec.chartE2eProbe}'
}
# Unknown to the CRD, the field is dropped, silently: what this chart's upgrades prevent.
[ -z "$(probe_kept --dry-run=server)" ] || fail "the test field is known before the upgrade that adds it"
crd_file="${kube}/probe/canyonos-operator/files/crds/canyonos.canyoncode.ai_canyonprojects.yaml"
awk '{ print }
  /^            description: spec defines the desired state of CanyonProject$/ { spec = 1 }
  spec && /^            properties:$/ { print "              chartE2eProbe:"; print "                type: string"; spec = 0 }' \
  "${crd_file}" > "${crd_file}.new"
mv "${crd_file}.new" "${crd_file}"
grep -q chartE2eProbe "${crd_file}" || fail "could not add the test field to the CRD"
helm upgrade canyonos /kube/probe/canyonos-operator --namespace "${NAMESPACE}" --reset-then-reuse-values \
  --wait --timeout 10m >/dev/null
[ "$(probe_kept)" = kept ] || fail "the API server dropped the field the upgraded CRD adds"
[ "$(k -n "${NS}" get canyonproject chart-e2e -o jsonpath='{.spec.chartE2eProbe}')" = kept ] \
  || fail "the new field was not stored"
same_project "after the CRD upgrade"
echo "the new field is kept; the project's Redis kept running"

log "helm rollback: the CRD before it, and the project stays"
helm rollback canyonos --namespace "${NAMESPACE}" --wait --timeout 10m >/dev/null
k get crd "${CRDS[0]}" -o yaml | grep -q chartE2eProbe && fail "the rollback left the newer CRD"
same_project "after the rollback"
echo "rolled back; the project's Redis kept running"

log "helm uninstall: the CRDs, the project and its pods stay"
helm uninstall canyonos --namespace "${NAMESPACE}" --wait --timeout 10m >/dev/null
for crd in "${CRDS[@]}"; do
  k get crd "${crd}" >/dev/null 2>&1 || fail "the uninstall deleted CRD ${crd}"
done
same_project "after the uninstall"
# The chart's builder and dashboard namespaces go with it: gone before installing again.
for ns in canyonos-build canyonos-dashboard; do
  k wait --for=delete "namespace/${ns}" --timeout=5m >/dev/null 2>&1 || true
  k get namespace "${ns}" >/dev/null 2>&1 && fail "namespace ${ns} is still terminating"
done
echo "uninstalled; the CRDs and the project stayed"

log "Installing again takes the project back"
operator
same_project "after installing again"
echo "the project is back under the operator"

log "A second install, in another namespace: refused before anything is applied"
said="$(helm install canyonos-second /kube/chart/canyonos-operator --namespace "${SECOND_NS}" \
  --create-namespace --set "${KEY}" 2>&1)" && fail "a second operator installed: ${said}"
echo "${said}" | grep -q "already installed in this cluster: Helm release \"canyonos\" in namespace \"${NAMESPACE}\"" \
  || fail "refused without saying why: ${said}"
helm status canyonos-second -n "${SECOND_NS}" >/dev/null 2>&1 && fail "the refused install left a release"
k get clusterrolebinding,clusterrole -l app.kubernetes.io/instance=canyonos-second -o name | grep -q . \
  && fail "the refused install applied cluster objects"
k delete namespace "${SECOND_NS}" --ignore-not-found --wait=false >/dev/null
echo "refused: ${said}"

log "Removing the test project"
k delete namespace "${NS}" --timeout=10m >/dev/null

log "CHART E2E PASS"
