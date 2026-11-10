#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only
#
# End-to-end test of CanyonOS on Kubernetes, on the kind cluster scripts/kind/up.sh
# makes. It builds CanyonOS's images from this checkout as `bun run canyonos:dev` does,
# installs them with scripts/kind/operator.sh (the operator, then the chart with the
# in-cluster builder and the dashboard), then, as a user who may only edit one
# namespace, deploys examples/helloworld with `canyonos target kubernetes` and a plain
# `canyonos deploy` and checks that:
#   - `canyonos target` names the namespace after the folder, finds the cluster's
#     registry, fills an empty kubernetes: block, and fails rather than waits on a
#     prompt when it cannot; `validate` refuses an empty block, and a config that is
#     not valid YAML is refused rather than taken for a Docker project;
#   - the endpoint stays on 127.0.0.1:8080, also once its pod is replaced, and
#     `canyonos serve` keeps the dashboard on 8081 and returns, and another project's
#     serve keeps it there;
#   - `doctor` and `status` fail when the cluster cannot be reached, `status --json`
#     still prints its report, and `stop` still closes the forwards;
#   - requests through the endpoint complete;
#   - the dashboard lists the project, reads its Redis and receives its telemetry;
#   - a rotated Redis password restarts every pod that uses it, and requests still work;
#   - `canyonos stop` closes both forwards, `canyonos clean` removes the project and
#     leaves the namespace, and `canyonos target docker` keeps the kubernetes: block.
#
# Usage: scripts/kind/e2e.sh   (CANYONOS_KIND_CLUSTER names another cluster than canyonos)
# Needs docker, kind, kubectl, bun and git on this machine; everything else runs in a
# container on the kind network, so it runs the same on Linux, macOS, Windows (Git Bash)
# and in CI.
set -euo pipefail
export MSYS_NO_PATHCONV=1

CLUSTER_NAME="${CANYONOS_KIND_CLUSTER:-canyonos}"
REGISTRY="localhost:5001"
NS="canyonos-e2e"
KUBECTL_VERSION="v1.36.0"

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
  apt-get -qq update >/dev/null && apt-get -qq install -y curl >/dev/null
  pip install -q --root-user-action=ignore --disable-pip-version-check uv==0.12.15
  arch="$(dpkg --print-architecture)"
  curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl"
  chmod +x /usr/local/bin/kubectl
  # The checkout as it is, uncommitted changes included, without build outputs: the
  # files listed on the host, since git cannot follow a worktree's host path from here.
  mkdir -p /w
  tar -C /src --null -T /kube/files -cf - | tar -C /w -xf -
  (cd /w && uv sync --locked -q)

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

  log "canyonos target kubernetes, then canyonos deploy (as the deployer)"
  cp -r /w/examples/helloworld /hw
  printf 'EXAMPLE=1\n' > /hw/.env
  # Development mode (no usage events, no upgrade check) naming the release image,
  # so the build runs the canyonos-core image the operator was installed with.
  export CANYONOS_ENV=development CANYONOS_USAGE_URL=""
  CANYONOS_CORE_IMAGE="$(cd /w && uv run --no-sync python -c 'from canyonos import env; print(env.PROD_CORE_IMAGE)')"
  export CANYONOS_CORE_IMAGE
  canyonos() { (cd /hw && KUBECONFIG="${DEPLOYER}" /w/.venv/bin/canyonos "$@"); }
  canyonos_in() {  # kubeconfig, project folder, then the command; never waits on a prompt
    local kubeconfig="$1" dir="$2"
    shift 2
    (cd "${dir}" && KUBECONFIG="${kubeconfig}" COLUMNS=200 timeout 600 /w/.venv/bin/canyonos "$@" </dev/null)
  }
  config_value() {  # project folder, dotted key: its value in workflow_config.yaml
    /w/.venv/bin/python -c 'import sys, yaml
value = yaml.safe_load(open(sys.argv[1]))
for key in sys.argv[2].split("."):
    value = value.get(key) if isinstance(value, dict) else None
print("" if value is None else value)' "$1/config/workflow_config.yaml" "$2"
  }

  log "canyonos target with no options takes the folder's name and the cluster's registry"
  cp -r /w/examples/helloworld /tmp/Target_Check
  canyonos_in "${ADMIN}" /tmp/Target_Check target kubernetes || fail "target with no options"
  [ "$(config_value /tmp/Target_Check target)" = kubernetes ] \
    && [ "$(config_value /tmp/Target_Check kubernetes.namespace)" = target-check ] \
    && [ "$(config_value /tmp/Target_Check kubernetes.registry)" = "${REGISTRY}" ] \
    || fail "target wrote: $(cat /tmp/Target_Check/config/workflow_config.yaml)"
  # The block goes right under `target`, keeping the file's order.
  grep -A1 '^target: kubernetes$' /tmp/Target_Check/config/workflow_config.yaml | grep -q '^kubernetes:$' \
    || fail "target did not put the kubernetes: block under target: $(cat /tmp/Target_Check/config/workflow_config.yaml)"
  shown="$(canyonos_in "${ADMIN}" /tmp/Target_Check target)" || fail "target (show): ${shown}"
  echo "${shown}" | grep -q "deploys to Kubernetes: namespace target-check" \
    || fail "target does not show where the project deploys: ${shown}"

  log "canyonos target fills an empty kubernetes: block, and validate refuses one"
  cp -r /w/examples/helloworld /tmp/Empty_Block
  sed -i 's/^target: docker$/target: kubernetes/' /tmp/Empty_Block/config/workflow_config.yaml
  printf 'kubernetes:\n  # namespace: later\n' >> /tmp/Empty_Block/config/workflow_config.yaml
  said="$(canyonos_in "${ADMIN}" /tmp/Empty_Block validate 2>&1)" && fail "validate passed an empty kubernetes: block"
  echo "${said}" | grep -q "kubernetes: section is missing or empty" \
    || fail "validate did not name the empty kubernetes: block: ${said}"
  canyonos_in "${ADMIN}" /tmp/Empty_Block target kubernetes || fail "target with an empty kubernetes: block"
  [ "$(config_value /tmp/Empty_Block kubernetes.namespace)" = empty-block ] \
    || fail "target left the kubernetes: block empty: $(cat /tmp/Empty_Block/config/workflow_config.yaml)"

  log "a config that is not valid YAML is refused, not taken for a Docker project"
  cp -r /w/examples/helloworld /tmp/Bad_Yaml
  sed -i 's/^target: docker$/target: kubernetes/' /tmp/Bad_Yaml/config/workflow_config.yaml
  printf 'kubernetes: [\n' >> /tmp/Bad_Yaml/config/workflow_config.yaml
  said="$(canyonos_in "${ADMIN}" /tmp/Bad_Yaml stop 2>&1)" && fail "stop passed with a config that is not YAML: ${said}"
  echo "${said}" | grep -q "Could not read" || fail "stop did not say it could not read the config: ${said}"

  log "canyonos target with no terminal and no --registry does not wait on a prompt"
  # The deployer may edit one namespace only, so it may not be able to read kube-public,
  # where the cluster advertises its registry: it then has to name it, not be asked.
  cp -r /w/examples/helloworld /tmp/hw-deployer
  rc=0
  said="$(canyonos_in "${DEPLOYER}" /tmp/hw-deployer target kubernetes --namespace "${NS}" 2>&1)" || rc=$?
  echo "exit ${rc}: ${said}"
  case "${rc}" in
    124) fail "target waited for an answer with no terminal to ask" ;;
    0) [ "$(config_value /tmp/hw-deployer kubernetes.registry)" = "${REGISTRY}" ] \
         || fail "target wrote another registry: $(cat /tmp/hw-deployer/config/workflow_config.yaml)" ;;
    *) echo "${said}" | grep -q -- "--registry" || fail "target failed without naming --registry"
       cmp -s /w/examples/helloworld/config/workflow_config.yaml /tmp/hw-deployer/config/workflow_config.yaml \
         || fail "a failed target still wrote the config: $(cat /tmp/hw-deployer/config/workflow_config.yaml)" ;;
  esac

  canyonos target kubernetes --namespace "${NS}" --registry "${REGISTRY}" || fail "target"
  grep -q '^target: kubernetes' /hw/config/workflow_config.yaml || fail "target not written"
  canyonos deploy || fail "deploy"
  # The deploy keeps the endpoint on 127.0.0.1:8080, as on Docker: an unknown request 404s.
  [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/status/e2e)" = 404 ] \
    || fail "the endpoint is not forwarded to 127.0.0.1:8080"

  canyonos status || fail "status"
  canyonos status --json | python -c 'import sys, json; json.load(sys.stdin)' \
    || fail "status --json is not JSON"
  canyonos doctor || fail "doctor"
  canyonos logs --no-follow --tail 5 >/dev/null || fail "logs"
  canyonos logs HelloAgent-0 --no-follow --tail 5 >/dev/null || fail "logs HelloAgent-0"
  project_id="$(grep -E '^project_id:' /hw/config/workflow_config.yaml | awk '{print $2}')"

  log "The endpoint stays on 127.0.0.1:8080 when its pod is replaced"
  selector="$(as_deployer kubectl -n "${NS}" get svc canyonos-endpoint \
    -o go-template='{{range $k, $v := .spec.selector}}{{$k}}={{$v}},{{end}}')"
  as_deployer kubectl -n "${NS}" delete pods -l "${selector%,}" --wait=true >/dev/null \
    || fail "could not delete the endpoint's pod"
  back=""
  for _ in $(seq 60); do
    if [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/status/e2e)" = 404 ]; then
      back=1
      break
    fi
    sleep 2
  done
  [ -n "${back}" ] || fail "the endpoint forward did not come back after its pod was replaced"
  as_deployer kubectl -n "${NS}" wait pods -l "${selector%,}" --for=condition=Ready --timeout=5m >/dev/null \
    || fail "the endpoint's new pod is not ready"

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

  log "canyonos serve keeps the dashboard on 127.0.0.1:8081 and returns"
  # As an admin: the deployer may not port-forward into the dashboard's namespace.
  canyonos_in "${ADMIN}" /hw serve || fail "serve"
  curl -sf -m 5 -o /dev/null http://127.0.0.1:8081/ || fail "the dashboard is not on 127.0.0.1:8081"

  log "another project's serve keeps the running dashboard on its port"
  printf 'dashboard_port: 9000\n' >> /tmp/Target_Check/config/workflow_config.yaml
  said="$(canyonos_in "${ADMIN}" /tmp/Target_Check serve)" || fail "serve from another project: ${said}"
  echo "${said}" | grep -q "127.0.0.1:8081" || fail "serve moved the running dashboard: ${said}"
  curl -sf -m 5 -o /dev/null http://127.0.0.1:8081/ || fail "the dashboard left 127.0.0.1:8081"

  log "doctor and status fail when the cluster cannot be reached"
  cat > /tmp/nowhere <<EOF
apiVersion: v1
kind: Config
clusters: [{name: nowhere, cluster: {server: "https://127.0.0.1:1"}}]
users: [{name: nobody, user: {token: none}}]
contexts: [{name: nowhere, context: {cluster: nowhere, user: nobody, namespace: ${NS}}}]
current-context: nowhere
EOF
  if canyonos_in /tmp/nowhere /hw doctor; then fail "doctor passed with no cluster to reach"; fi
  said="$(canyonos_in /tmp/nowhere /hw status 2>&1)" && fail "status passed with no cluster to reach: ${said}"
  if echo "${said}" | grep -q "No CanyonOS project"; then
    fail "status says there is no project when the cluster cannot be reached: ${said}"
  fi
  said="$(canyonos_in /tmp/nowhere /hw status --json 2>/dev/null)" \
    && fail "status --json passed with no cluster to reach: ${said}"
  echo "${said}" | python -c 'import sys, json; r = json.load(sys.stdin); assert r["errors"] and not r["running"]' \
    || fail "status --json printed no report with its errors: ${said}"

  log "stop with no cluster to reach fails, and still closes the forwards"
  forwards() {  # the forwards' records and every kubectl or forward process, for a failure
    head -v "${HOME}"/.canyonos/forwards/* 2>&1
    for p in /proc/[0-9]*; do
      c="$(tr '\0' ' ' <"${p}/cmdline" 2>/dev/null)" || continue
      case "${c}" in *kubectl*|*__port-forward*) echo "${p#/proc/}: ${c}" ;; esac
    done
  }
  if canyonos_in /tmp/nowhere /hw stop; then fail "stop passed with no cluster to reach"; fi
  curl -s -m 5 -o /dev/null http://127.0.0.1:8080/ && fail "a failed stop left the endpoint forwarded: $(forwards)"
  curl -s -m 5 -o /dev/null http://127.0.0.1:8081/ && fail "a failed stop left the dashboard forwarded: $(forwards)"

  log "deploy and serve again, so the stop below has both forwards to close"
  canyonos deploy || fail "deploy again"
  canyonos_in "${ADMIN}" /hw serve || fail "serve again"
  [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/status/e2e)" = 404 ] \
    || fail "the redeploy did not forward the endpoint to 127.0.0.1:8080"
  curl -sf -m 5 -o /dev/null http://127.0.0.1:8081/ || fail "serve did not open the dashboard again"

  log "canyonos stop, then clean"
  canyonos stop || fail "stop"
  as_deployer kubectl -n "${NS}" get canyonproject -o name | grep -q . && fail "the project is still there"
  curl -s -m 5 -o /dev/null http://127.0.0.1:8080/ && fail "stop left the endpoint forwarded"
  curl -s -m 5 -o /dev/null http://127.0.0.1:8081/ && fail "stop left the dashboard forwarded"
  ls "${HOME}"/.canyonos/forwards/*.json >/dev/null 2>&1 \
    && fail "stop left forwards running: $(ls "${HOME}/.canyonos/forwards")"
  canyonos clean || fail "clean"
  for _ in $(seq 30); do
    left="$(as_deployer kubectl -n "${NS}" get pods,configmaps,secrets,canyonagents -l canyonos.canyoncode.ai/project -o name)"
    [ -z "${left}" ] && break
    sleep 2
  done
  [ -z "${left}" ] || fail "left behind: ${left}"
  as_admin kubectl get namespace "${NS}" >/dev/null || fail "clean deleted the namespace"

  log "canyonos target docker switches back and keeps the kubernetes: block"
  # Its Docker checks fail in this container, which has no Docker: only the config counts.
  canyonos target docker || true
  [ "$(config_value /hw target)" = docker ] && [ "$(config_value /hw kubernetes.namespace)" = "${NS}" ] \
    || fail "target docker wrote: $(cat /hw/config/workflow_config.yaml)"

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
command -v bun >/dev/null || { echo "Missing 'bun' on PATH: it builds the images (bun run canyonos:dev)" >&2; exit 1; }
kind get clusters 2>/dev/null | grep -qx "${CLUSTER_NAME}" || { echo "No kind cluster ${CLUSTER_NAME}: run scripts/kind/up.sh" >&2; exit 1; }
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && { pwd -W 2>/dev/null || pwd; })"

log "CanyonOS's images from this checkout (bun run canyonos:dev --images-only)"
(cd "${REPO}" && bun run canyonos:dev --images-only)
CANYONOS_KIND_CLUSTER="${CLUSTER_NAME}" "$(dirname "${BASH_SOURCE[0]}")/operator.sh"

kube="$(mktemp -d)"
trap 'rm -rf "${kube}"' EXIT
kind get kubeconfig --internal --name "${CLUSTER_NAME}" > "${kube}/admin"
git -C "${REPO}" ls-files -co --exclude-standard -z > "${kube}/files"
docker run --rm --network kind \
  -v "${REPO}:/src:ro" -v "$(cd "${kube}" && { pwd -W 2>/dev/null || pwd; }):/kube:ro" \
  python:3.12-slim bash /src/scripts/kind/e2e.sh --inside
