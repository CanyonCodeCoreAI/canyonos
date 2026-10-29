#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only
#
# End-to-end test of CanyonOS on Kubernetes, on the kind cluster scripts/kind/up.sh
# makes. From this checkout it builds the operator, canyonos-core, api and web images,
# installs the operator's chart with the in-cluster builder and the dashboard, then,
# as a user who may only edit one namespace, deploys examples/helloworld with the real
# `canyonos deploy --target kubernetes` and checks that:
#   - requests through the endpoint complete;
#   - the dashboard lists the project, reads its Redis and receives its telemetry;
#   - a rotated Redis password restarts every pod that uses it, and requests still work;
#   - `canyonos stop` and `canyonos clean` remove the project and leave the namespace.
#
# Usage: scripts/kind/e2e.sh   (CANYONOS_KIND_CLUSTER names another cluster than canyonos)
# Needs docker and kind on this machine; everything else runs in a container on the
# kind network, so it runs the same on Linux, macOS, Windows (Git Bash) and in CI.
set -euo pipefail
export MSYS_NO_PATHCONV=1

CLUSTER_NAME="${CANYONOS_KIND_CLUSTER:-canyonos}"
REGISTRY="localhost:5001"
NS="canyonos-e2e"
KUBECTL_VERSION="v1.36.0"
HELM_VERSION="v3.17.3"

log() { printf '\n== %s\n' "$*"; }

# ------------------------------------------------------------------------------------
# Inside the container: the test itself.
# ------------------------------------------------------------------------------------
inside() {
  ADMIN="/kube/admin"
  DEPLOYER="/tmp/deployer"
  fail() {
    echo "FAIL: $*" >&2
    KUBECONFIG="${ADMIN}" kubectl get pods -A -o wide >&2 || true
    KUBECONFIG="${ADMIN}" kubectl -n canyonos-system logs deploy/canyonos-controller-manager --tail=40 >&2 || true
    exit 1
  }
  as_admin() { KUBECONFIG="${ADMIN}" "$@"; }
  as_deployer() { KUBECONFIG="${DEPLOYER}" "$@"; }

  log "Tools"
  export DEBIAN_FRONTEND=noninteractive
  apt-get -qq update >/dev/null && apt-get -qq install -y git curl >/dev/null
  pip install -q --root-user-action=ignore --disable-pip-version-check uv==0.12.15
  arch="$(dpkg --print-architecture)"
  curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl"
  chmod +x /usr/local/bin/kubectl
  curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-${arch}.tar.gz" | tar -xz -C /usr/local/bin --strip-components=1 "linux-${arch}/helm"
  # The checkout as it is, uncommitted changes included, without build outputs.
  git config --global --add safe.directory '*'
  mkdir -p /w
  git -C /src ls-files -co --exclude-standard -z | tar -C /src --null -T - -cf - | tar -C /w -xf -
  (cd /w && uv sync --locked -q)

  log "Operator chart, with the in-cluster builder and the dashboard (images ${TAG})"
  # Helm never upgrades crds/: on a cluster an earlier run used, apply them first,
  # taking them over from Helm, which installed them.
  as_admin kubectl apply --server-side --force-conflicts -f /w/packages/operator/charts/canyonos-operator/crds/ >/dev/null \
    || fail "CRDs"
  as_admin helm upgrade --install canyonos /w/packages/operator/charts/canyonos-operator \
    --namespace canyonos-system --create-namespace \
    --set image.repository="${REGISTRY}/canyonos-operator" --set image.tag="${TAG}" \
    --set controllerImage="${REGISTRY}/canyonos-core:${TAG}" \
    --set builder.enabled=true \
    --set "builder.insecureRegistries={kind-registry:5000}" \
    --set "builder.registryAliases.localhost:5001=kind-registry:5000" \
    --set dashboard.enabled=true \
    --set dashboard.apiImage="${REGISTRY}/canyonos-api:${TAG}" \
    --set dashboard.webImage="${REGISTRY}/canyonos-web:${TAG}" \
    --wait --timeout 10m >/dev/null || fail "chart install"
  echo "installed"

  log "A namespace and a user who may only edit it"
  # A failed run's project can take the operator's five-minute teardown give-up to go.
  as_admin kubectl delete namespace "${NS}" --ignore-not-found --timeout=10m >/dev/null
  as_admin kubectl create namespace "${NS}" >/dev/null
  as_admin kubectl -n "${NS}" create serviceaccount deployer >/dev/null
  as_admin kubectl -n "${NS}" create rolebinding deployer --clusterrole=edit --serviceaccount="${NS}:deployer" >/dev/null
  server="$(as_admin kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
  ca="$(as_admin kubectl config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')"
  token="$(as_admin kubectl -n "${NS}" create token deployer --duration=1h)"
  cat > "${DEPLOYER}" <<EOF
apiVersion: v1
kind: Config
clusters: [{name: kind, cluster: {server: "${server}", certificate-authority-data: "${ca}"}}]
users: [{name: deployer, user: {token: "${token}"}}]
contexts: [{name: deployer, context: {cluster: kind, user: deployer, namespace: ${NS}}}]
current-context: deployer
EOF
  [ "$(as_deployer kubectl auth can-i get crds 2>/dev/null)" = "no" ] || fail "the deployer may read CRDs"

  log "canyonos deploy --target kubernetes (as the deployer)"
  cp -r /w/examples/helloworld /hw
  printf '\nkubernetes:\n  namespace: %s\n  registry: %s\n' "${NS}" "${REGISTRY}" >> /hw/config/global_controller.yaml
  printf 'EXAMPLE=1\n' > /hw/.env
  # Development mode (no usage events, no upgrade check) naming the release image,
  # so the build runs the canyonos-core image the operator was installed with.
  export CANYONOS_ENV=development CANYONOS_USAGE_URL=""
  CANYONOS_CORE_IMAGE="$(cd /w && uv run --no-sync python -c 'from canyonos import env; print(env.PROD_CORE_IMAGE)')"
  export CANYONOS_CORE_IMAGE
  canyonos() { (cd /hw && KUBECONFIG="${DEPLOYER}" /w/.venv/bin/canyonos "$@"); }
  canyonos deploy --target kubernetes || fail "deploy"
  canyonos status --target kubernetes || fail "status"
  canyonos status --target kubernetes --json | python -c 'import sys, json; json.load(sys.stdin)' \
    || fail "status --json is not JSON"
  canyonos logs --target kubernetes --no-follow --tail 5 >/dev/null || fail "logs"
  canyonos logs --target kubernetes HelloAgent-0 --no-follow --tail 5 >/dev/null || fail "logs HelloAgent-0"
  project_id="$(grep -E '^project_id:' /hw/config/global_controller.yaml | awk '{print $2}')"

  requests() {
    as_deployer kubectl -n "${NS}" port-forward svc/canyonos-endpoint 18080:8080 >/dev/null 2>&1 &
    local forward=$! ok=0 id
    for _ in $(seq 30); do curl -s -m 5 -o /dev/null http://127.0.0.1:18080/ && break; sleep 2; done
    for n in 1 2 3 4 5; do
      id="$(curl -s -m 10 -X POST http://127.0.0.1:18080/main -H 'Content-Type: application/json' \
        -d "{\"query\": \"e2e ${n}\"}" | python -c 'import sys, json; print(json.load(sys.stdin)["request_id"])' 2>/dev/null || true)"
      for _ in $(seq 60); do
        case "$(curl -s -m 5 "http://127.0.0.1:18080/status/${id}")" in *'"done"'*) ok=$((ok + 1)); break ;; esac
        sleep 0.5
      done
    done
    kill "${forward}" 2>/dev/null || true
    echo "requests done: ${ok}/5"
    [ "${ok}" = 5 ]
  }
  log "Requests through the endpoint"
  requests || fail "requests"

  log "The dashboard lists the project, reads its Redis and receives its telemetry"
  for _ in $(seq 30); do
    as_admin kubectl -n canyonos-dashboard get secret canyonos-dashboard-projects \
      -o jsonpath='{.data.projects\.json}' 2>/dev/null | base64 -d | grep -q "${project_id}" && break
    sleep 2
  done
  as_admin kubectl -n canyonos-dashboard port-forward svc/canyonos-dashboard-api 18081:3000 >/dev/null 2>&1 &
  dashboard_forward=$!
  api="http://127.0.0.1:18081"
  for _ in $(seq 30); do curl -s -m 5 -o /dev/null "${api}/auth/status" && break; sleep 2; done
  password="e2e-Password-123!"
  session="$(curl -s -X POST "${api}/auth/register" -H 'Content-Type: application/json' \
    -d "{\"email\": \"e2e@canyonos.test\", \"password\": \"${password}\", \"password_confirmation\": \"${password}\"}")"
  token="$(echo "${session}" | python -c 'import sys, json; print(json.load(sys.stdin).get("token", ""))')"
  if [ -z "${token}" ]; then  # an earlier run on this cluster made the account
    session="$(curl -s -X POST "${api}/auth/login" -H 'Content-Type: application/json' \
      -d "{\"email\": \"e2e@canyonos.test\", \"password\": \"${password}\"}")"
    token="$(echo "${session}" | python -c 'import sys, json; print(json.load(sys.stdin).get("token", ""))')"
  fi
  [ -n "${token}" ] || fail "no dashboard session: ${session}"
  get() { curl -s -H "Authorization: Bearer ${token}" "${api}$1"; }
  until_found() {  # path, text, what
    for _ in $(seq 40); do get "$1" | grep -q "$2" && return 0; sleep 5; done
    fail "$3: $(get "$1")"
  }
  until_found /projects "${project_id}" "the dashboard does not list the project"
  until_found "/projects/${project_id}/monitoring/endpoint" "canyonos-endpoint.${NS}.svc" \
    "the dashboard could not read the project's Redis"
  until_found "/projects/${project_id}/monitoring/replicas" '"replica":' "no telemetry reached the dashboard"
  echo "listed, Redis read, telemetry in"

  log "A rotated Redis password restarts every pod that uses it"
  login() {
    as_deployer kubectl -n "${NS}" get deploy canyonos-gc \
      -o jsonpath='{.spec.template.metadata.annotations.canyonos\.canyoncode\.ai/redis-login}'
  }
  pods_on() {  # every pod that signs in to Redis: its login, ready, not terminating
    as_deployer kubectl -n "${NS}" get pods -l canyonos.canyoncode.ai/project -o jsonpath='{range .items[?(@.metadata.annotations.canyonos\.canyoncode\.ai/redis-login)]}{.metadata.annotations.canyonos\.canyoncode\.ai/redis-login},{.status.containerStatuses[0].ready},{.metadata.deletionTimestamp}{"\n"}{end}'
  }
  before="$(login)"
  as_deployer kubectl -n "${NS}" delete secret canyonos-redis >/dev/null
  rolled=""
  for _ in $(seq 120); do
    now="$(login)"
    if [ -n "${now}" ] && [ "${now}" != "${before}" ] && ! pods_on | grep -v "^${now},true,$" | grep -q .; then
      rolled=1
      break
    fi
    sleep 5
  done
  [ -n "${rolled}" ] || fail "pods still sign in with the old password: $(pods_on)"
  requests || fail "requests after the rotation"
  until_found "/projects/${project_id}/monitoring/endpoint" "canyonos-endpoint.${NS}.svc" \
    "the dashboard lost the project's Redis after the rotation"
  kill "${dashboard_forward}" 2>/dev/null || true

  log "canyonos stop, then clean"
  canyonos stop --target kubernetes || fail "stop"
  as_deployer kubectl -n "${NS}" get canyonproject -o name | grep -q . && fail "the project is still there"
  canyonos clean --target kubernetes || fail "clean"
  for _ in $(seq 30); do
    left="$(as_deployer kubectl -n "${NS}" get pods,configmaps,secrets,canyonagents -l canyonos.canyoncode.ai/project -o name)"
    [ -z "${left}" ] && break
    sleep 2
  done
  [ -z "${left}" ] || fail "left behind: ${left}"
  as_admin kubectl get namespace "${NS}" >/dev/null || fail "clean deleted the namespace"
  as_admin kubectl delete namespace "${NS}" --wait=false >/dev/null

  log "E2E PASS"
}

if [ "${1:-}" = "--inside" ]; then
  inside
  exit
fi

# ------------------------------------------------------------------------------------
# On this machine: the images, then the test in a container on the kind network.
# ------------------------------------------------------------------------------------
command -v kind >/dev/null || { echo "Missing 'kind' on PATH (scripts/kind/up.sh needs it too)" >&2; exit 1; }
kind get clusters 2>/dev/null | grep -qx "${CLUSTER_NAME}" || { echo "No kind cluster ${CLUSTER_NAME}: run scripts/kind/up.sh" >&2; exit 1; }
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && { pwd -W 2>/dev/null || pwd; })"
# A new tag every run: a node never runs an image it cached from an earlier one.
TAG="e2e-$(date +%Y%m%d%H%M%S)"

build() {  # name, Dockerfile, context, extra docker build arguments
  log "Image ${REGISTRY}/canyonos-$1:${TAG}"
  # Quiet unless it fails; then the end of the build's own output says why.
  local out
  out="$(mktemp)"
  if ! docker build --progress=plain -f "${REPO}/$2" -t "${REGISTRY}/canyonos-$1:${TAG}" "${@:4}" "${REPO}/$3" > "${out}" 2>&1; then
    tail -60 "${out}" >&2
    rm -f "${out}"
    df -h / >&2 || true
    exit 1
  fi
  rm -f "${out}"
  docker push -q "${REGISTRY}/canyonos-$1:${TAG}" >/dev/null
}
build operator packages/operator/Dockerfile packages/operator
build core packages/core/Dockerfile packages/core
build api packages/api/Dockerfile .
build web packages/web/Dockerfile . --target canyonos --build-arg VITE_API_URL=/api

kube="$(mktemp -d)"
trap 'rm -rf "${kube}"' EXIT
kind get kubeconfig --internal --name "${CLUSTER_NAME}" > "${kube}/admin"
docker run --rm --network kind \
  -v "${REPO}:/src:ro" -v "$(cd "${kube}" && { pwd -W 2>/dev/null || pwd; }):/kube:ro" \
  -e TAG="${TAG}" \
  python:3.12-slim bash /src/scripts/kind/e2e.sh --inside
