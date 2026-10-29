#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only
#
# Make the local CanyonOS Kubernetes cluster, ready to deploy to: kind (1 control plane
# and, by default, 1 worker), Calico for NetworkPolicy, metrics-server, Pod Security
# `restricted` enforced in every namespace, a registry on localhost:5001 that the nodes
# pull from the same way EKS nodes pull from ECR or OpenShift nodes from the internal
# registry, and then CanyonOS itself (scripts/kind/operator.sh): the operator, the
# in-cluster image builder and the dashboard, from the images `bun run canyonos:dev`
# builds from this checkout.
#
# Usage: scripts/kind/up.sh [--no-operator] [--verify]
#   (nothing)      CanyonOS built from this checkout (its images built first if missing).
#   --no-operator  Only the cluster and its registry.
#   --verify       Push a test image, run it as a restricted pod, check that a pod
#                  which breaks the restricted profile is rejected and that a
#                  deny-all NetworkPolicy is enforced.
# Environment:
#   CANYONOS_KIND_WORKERS  Worker nodes (default 1), set when the cluster is made. More
#                    nodes add no CPU or memory (they share Docker's); they let a project
#                    spread its pods over nodes, as on a real cluster.
#   KIND_NODE_IMAGE  Kubernetes version to run (a kindest/node image), to test against
#                    the version a target cluster runs.
#   CANYONOS_KIND_CLUSTER  The cluster's name (default canyonos).
#   CANYONOS_KIND_CONFIG  Where the API server's Pod Security file is kept for the
#                    cluster's lifetime (default ~/.canyonos/kind).
# Safe to re-run: existing pieces are kept, and CanyonOS is upgraded in place.
set -euo pipefail
# Git Bash on Windows rewrites /etc/... arguments into Windows paths.
export MSYS_NO_PATHCONV=1

CLUSTER_NAME="${CANYONOS_KIND_CLUSTER:-canyonos}"
NODE_IMAGE="${KIND_NODE_IMAGE:-kindest/node:v1.36.4@sha256:099e049362a1526b2db71494e1947aae99bd16290d7c895f2b7ea312e3cbfaed}"
REGISTRY_IMAGE="registry:3.1.1"
REGISTRY_NAME="kind-registry"
REGISTRY_PORT="5001"
CALICO_VERSION="v3.32.2"
METRICS_SERVER_VERSION="v0.9.0"
SMOKE_IMAGE="localhost:${REGISTRY_PORT}/canyonos-smoke:1"
# A native path: on Git Bash `pwd -W` gives C:/..., which kind.exe and Docker can open.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && { pwd -W 2>/dev/null || pwd; })"
# The API server reads its Pod Security file on every start, so it lives outside the
# repository: a branch without scripts/kind must not stop the cluster from starting.
CONFIG_DIR="${CANYONOS_KIND_CONFIG:-${HOME}/.canyonos/kind}"
WORKERS="${CANYONOS_KIND_WORKERS:-1}"

log() { printf '\n== %s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing '$1' on PATH: $2" >&2; exit 1; }; }
native() { cygpath -m "$1" 2>/dev/null || echo "$1"; }
usage() { sed -n '/^# Usage:/,/^# Safe to re-run/p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

verify=""
operator="checkout"  # checkout or none
while [ $# -gt 0 ]; do
  case "$1" in
    --verify) verify=1 ;;
    --no-operator) operator="none" ;;
    *) usage ;;
  esac
  shift
done
case "${WORKERS}" in ''|*[!0-9]*|0) echo "CANYONOS_KIND_WORKERS must be 1 or more" >&2; exit 2 ;; esac

need docker "install Docker Desktop or Docker Engine"
need kind "https://kind.sigs.k8s.io/docs/user/quick-start/#installation"
need kubectl "https://kubernetes.io/docs/tasks/tools/"
docker info >/dev/null 2>&1 || { echo "Docker is not running." >&2; exit 1; }
if [ "${operator}" = "checkout" ]; then
  # CanyonOS is installed from the images `bun run canyonos:dev` builds: build them now
  # when this checkout has none yet.
  for name in core api web; do
    if ! docker image inspect "canyonos-${name}:dev" >/dev/null 2>&1; then
      need bun "https://bun.sh: it builds CanyonOS's images (bun run canyonos:dev)"
      log "CanyonOS's images from this checkout (bun run canyonos:dev --images-only)"
      (cd "$(dirname "${BASH_SOURCE[0]}")/../.." && bun run canyonos:dev --images-only)
      break
    fi
  done
fi

# Every node, pod and image build shares what Docker has, whatever the node count.
read -r cpus memory <<< "$(docker info --format '{{.NCPU}} {{.MemTotal}}')"
memory_mib=$((memory / 1024 / 1024))
echo "Docker has ${cpus} CPUs and $((memory_mib / 1024)) GiB of memory"
if [ "${cpus}" -lt 4 ] || [ "${memory_mib}" -lt 7500 ]; then
  echo "Warning: CanyonOS with its builder and dashboard wants at least 4 CPUs and 8 GB." >&2
  echo "Give Docker more (Docker Desktop: Settings > Resources), or deploys may wait for room." >&2
fi

log "Registry ${REGISTRY_NAME} on localhost:${REGISTRY_PORT}"
if [ "$(docker inspect -f '{{.State.Running}}' "${REGISTRY_NAME}" 2>/dev/null || true)" != "true" ]; then
  docker rm -f "${REGISTRY_NAME}" >/dev/null 2>&1 || true
  docker run -d --restart=always -p "127.0.0.1:${REGISTRY_PORT}:5000" \
    --network bridge --name "${REGISTRY_NAME}" "${REGISTRY_IMAGE}" >/dev/null
fi

log "Cluster ${CLUSTER_NAME} (${NODE_IMAGE%@*})"
if kind get clusters 2>/dev/null | grep -qx "${CLUSTER_NAME}"; then
  have="$(kind get nodes --name "${CLUSTER_NAME}" | grep -c worker || true)"
  echo "already exists, with ${have} worker(s)"
  if [ "${have}" != "${WORKERS}" ]; then
    echo "CANYONOS_KIND_WORKERS=${WORKERS} applies to a new cluster: scripts/kind/down.sh, then this again"
  fi
else
  mkdir -p "${CONFIG_DIR}"
  cp "${HERE}/pod-security.yaml" "${CONFIG_DIR}/pod-security.yaml"
  config="$(mktemp)"
  trap 'rm -f "${config}"' EXIT
  sed "s#__CONFIG__#$(native "${CONFIG_DIR}")#" "${HERE}/cluster.yaml" > "${config}"
  # cluster.yaml has the first worker.
  for _ in $(seq 2 "${WORKERS}"); do echo "  - role: worker" >> "${config}"; done
  kind create cluster --name "${CLUSTER_NAME}" --image "${NODE_IMAGE}" \
    --config "$(native "${config}")" --wait 0s
fi
kubectl config use-context "kind-${CLUSTER_NAME}" >/dev/null

log "Nodes pull localhost:${REGISTRY_PORT} from the registry container"
for node in $(kind get nodes --name "${CLUSTER_NAME}"); do
  dir="/etc/containerd/certs.d/localhost:${REGISTRY_PORT}"
  docker exec "${node}" mkdir -p "${dir}"
  printf '[host."http://%s:5000"]\n' "${REGISTRY_NAME}" | docker exec -i "${node}" cp /dev/stdin "${dir}/hosts.toml"
done
if [ "$(docker inspect -f '{{json .NetworkSettings.Networks.kind}}' "${REGISTRY_NAME}")" = "null" ]; then
  docker network connect kind "${REGISTRY_NAME}"
fi
# Tells tools where the cluster's local registry is (KEP-1755).
kubectl apply -f - >/dev/null <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: local-registry-hosting
  namespace: kube-public
data:
  localRegistryHosting.v1: |
    host: "localhost:${REGISTRY_PORT}"
    help: "https://kind.sigs.k8s.io/docs/user/local-registry/"
EOF

log "Calico ${CALICO_VERSION}"
kubectl apply --server-side -f "https://raw.githubusercontent.com/projectcalico/calico/${CALICO_VERSION}/manifests/calico.yaml" >/dev/null
kubectl -n kube-system rollout status daemonset/calico-node --timeout=300s
kubectl wait --for=condition=Ready nodes --all --timeout=300s

log "metrics-server ${METRICS_SERVER_VERSION}"
kubectl apply -f "https://github.com/kubernetes-sigs/metrics-server/releases/download/${METRICS_SERVER_VERSION}/components.yaml" >/dev/null
# kind kubelets use self-signed serving certificates.
if ! kubectl -n kube-system get deployment metrics-server -o jsonpath='{.spec.template.spec.containers[0].args}' | grep -q kubelet-insecure-tls; then
  kubectl -n kube-system patch deployment metrics-server --type=json \
    -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]' >/dev/null
fi
kubectl -n kube-system rollout status deployment/metrics-server --timeout=300s

# A pod that meets the restricted profile, as every CanyonOS pod must.
smoke_pod() {
  local name="$1" command="$2"
  cat <<EOF
apiVersion: v1
kind: Pod
metadata: {name: ${name}, labels: {app: ${name}}}
spec:
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    runAsUser: 65534
    seccompProfile: {type: RuntimeDefault}
  containers:
    - name: main
      image: ${SMOKE_IMAGE}
      command: [sh, -c, '${command}']
      securityContext:
        allowPrivilegeEscalation: false
        capabilities: {drop: [ALL]}
EOF
}

if [ -n "${verify}" ]; then
  log "Verify: image push and pull through localhost:${REGISTRY_PORT}"
  docker pull -q busybox:1.37 >/dev/null
  docker tag busybox:1.37 "${SMOKE_IMAGE}"
  docker push -q "${SMOKE_IMAGE}" >/dev/null
  kubectl create namespace canyonos-smoke --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  kubectl -n canyonos-smoke delete pod --all --now >/dev/null 2>&1 || true
  smoke_pod server 'echo ok > /tmp/index.html && httpd -f -p 8080 -h /tmp' | kubectl -n canyonos-smoke apply -f - >/dev/null
  # A long-running client plus exec: `kubectl run --rm -i` drops output without a terminal.
  smoke_pod client 'sleep 600' | kubectl -n canyonos-smoke apply -f - >/dev/null
  kubectl -n canyonos-smoke wait --for=condition=Ready pod/server pod/client --timeout=180s >/dev/null
  echo "restricted pods from the local registry: running"

  log "Verify: Pod Security rejects a pod outside the restricted profile"
  if out="$(kubectl -n canyonos-smoke run root-pod --image="${SMOKE_IMAGE}" --restart=Never \
      --dry-run=server -- sleep 1 2>&1)"; then
    echo "FAIL: a pod without the restricted securityContext was admitted" >&2; exit 1
  fi
  echo "${out}" | grep -q "violates PodSecurity" \
    || { echo "FAIL: unexpected error: ${out}" >&2; exit 1; }
  echo "pod without the restricted securityContext: rejected (expected)"

  log "Verify: a deny-all NetworkPolicy is enforced"
  ip="$(kubectl -n canyonos-smoke get pod server -o jsonpath='{.status.podIP}')"
  probe() {
    kubectl -n canyonos-smoke exec client -- wget -qO- -T 3 "http://${ip}:8080" 2>/dev/null || true
  }
  [ "$(probe)" = "ok" ] && echo "pod-to-pod traffic: allowed (expected)" \
    || { echo "FAIL: pod could not reach the test server" >&2; exit 1; }
  kubectl -n canyonos-smoke apply -f - >/dev/null <<EOF
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-all-ingress
spec:
  podSelector: {matchLabels: {app: server}}
  policyTypes: [Ingress]
EOF
  sleep 3
  [ -z "$(probe)" ] && echo "after deny-all: blocked (expected)" \
    || { echo "FAIL: NetworkPolicy is not enforced" >&2; exit 1; }

  log "Verify: metrics API serves pod metrics in a namespace"
  for _ in $(seq 1 30); do
    kubectl -n canyonos-smoke top pod server >/dev/null 2>&1 && break
    sleep 5
  done
  kubectl -n canyonos-smoke top pod server >/dev/null \
    || { echo "FAIL: no pod metrics from metrics.k8s.io" >&2; exit 1; }
  echo "pod metrics: available"

  kubectl delete namespace canyonos-smoke --wait=false >/dev/null
  echo "verify: OK"
fi

if [ "${operator}" = "checkout" ]; then
  CANYONOS_KIND_CLUSTER="${CLUSTER_NAME}" "$(dirname "${BASH_SOURCE[0]}")/operator.sh"
fi

log "Ready"
kubectl get nodes -o wide
echo "Registry: localhost:${REGISTRY_PORT}  ·  context: kind-${CLUSTER_NAME}"
if [ "${operator}" != "none" ]; then
  cat <<EOF

Deploy a project to it, in the dev shell (bun run canyonos:dev), from the project's folder:
  1. Add to config/global_controller.yaml:
       kubernetes:
         namespace: <a namespace for it, e.g. its name>
         registry: localhost:${REGISTRY_PORT}
  2. canyonos deploy --target kubernetes
  3. canyonos serve --target kubernetes     # the dashboard, on http://127.0.0.1:8081
After changing CanyonOS, bun run canyonos:dev updates this cluster too.
Done with it: canyonos clean --target kubernetes, and scripts/kind/down.sh for the cluster.
EOF
fi
