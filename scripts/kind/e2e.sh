#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only
#
# End-to-end test of CanyonOS on Kubernetes, on the kind cluster scripts/kind/up.sh
# makes. It builds CanyonOS's images from this checkout as `bun run canyonos:dev` does,
# installs them with scripts/kind/operator.sh (the operator, then the chart with the
# in-cluster builder, the CanyonOS API and the dashboard), then, as a user who may only
# edit one namespace, deploys examples/helloworld's deployment with `target: kubernetes`
# and a plain `canyonos deploy helloworld` and checks that:
#   - `canyonos deploy --api-key` hands the CanyonBuild and the CanyonProject the key's
#     sha256 and neither holds the key itself; `deploy --no-api-key` opens the endpoint,
#     and CANYONOS_API_KEY sets the key for one deploy;
#   - `deploy` refuses an empty kubernetes: block, saying what to add, and a config that is not valid YAML
#     is refused rather than taken for a Docker deployment;
#   - the endpoint needs the API key: none is 401 auth.missing_key, another one 401
#     auth.invalid_key, a 503 auth.not_ready while the Global Controller has not
#     published its hash counts as not up, `canyonos test` sends the key and never
#     shows it, and a deploy with a new key refuses the old one;
#   - one workflow group runs per namespace: another one, from another folder or from
#     one of the same name, is refused before anything of it is written, stopping it
#     leaves the first alone, a CanyonProject applied by hand reports NamespaceInUse,
#     and the first one's objects stay as they were and it keeps answering;
#   - the endpoint stays on 127.0.0.1:8080, also once its pod is replaced, and
#     `canyonos serve` keeps the dashboard on 8081 and returns, and another project's
#     serve keeps it there;
#   - `doctor` and `status` fail when the cluster cannot be reached, `status --json`
#     still prints its report, and `stop` still closes the forwards;
#   - requests through the endpoint complete, also at /<workflow_id>, the URL
#     `status --json` gives, as on Docker; an unknown request 404s at once, with no
#     lookup in a dashboard database the namespace cannot reach;
#   - in a workflow group of two workflows, a code change in one rolls only its agents
#     out, while the other keeps its pods and answers every request, and the
#     CanyonProject and Redis stay; the rollout runs after the deploy hands it over, so
#     `deploy --detach` returns while it rolls; deploying one of them alone takes the other's agents
#     and .env Secret out, and nothing else;
#   - the CanyonOS API, restarted, still knows the running workflow group;
#   - the dashboard lists the project's workflow by its own id, never the workflow
#     group's, reads its Redis and receives its telemetry; its API takes the key whose
#     hash is in the chart's Secret (api-key-hash), refuses a request with no key or
#     another one, and reads and changes with it; its /v1/readyz reports the database ok
#     and Docker disabled;
#   - a rotated Redis password restarts every pod that uses it, and requests still work;
#   - `canyonos stop` closes both forwards, and `canyonos clean` removes the project and
#     leaves the namespace;
#   - with `deploy_mode: toy`, one agent StatefulSet runs the project and answers.
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
  ADMIN_TOKEN="/tmp/admin-token"
  fail() {
    echo "FAIL: $*" >&2
    KUBECONFIG="${ADMIN}" kubectl get pods -A -o wide >&2 || true
    KUBECONFIG="${ADMIN}" kubectl -n canyonos-system logs deploy/canyonos-controller-manager --tail=40 >&2 || true
    # The CanyonOS API runs every deploy: its Bun process, and the core commands it queues.
    for container in api core; do
      KUBECONFIG="${ADMIN}" kubectl -n canyonos-dashboard logs deploy/canyonos-dashboard-api -c "${container}" \
        --tail=80 --prefix >&2 || true
    done
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
  # The CanyonOS API accepts only token logins, and kind's admin signs in with a certificate.
  as_admin kubectl -n "${NS}" create serviceaccount admin >/dev/null
  as_admin kubectl create clusterrolebinding canyonos-e2e-admin --clusterrole=cluster-admin \
    --serviceaccount="${NS}:admin" --dry-run=client -o yaml | as_admin kubectl apply -f - >/dev/null
  sed "s|${token}|$(as_admin kubectl -n "${NS}" create token admin --duration=1h)|" "${DEPLOYER}" > "${ADMIN_TOKEN}"

  log "canyonos deploy (as the deployer)"
  cp -r /w/examples/helloworld /hw
  printf 'EXAMPLE=1\n' > /hw/helloworld/.env
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
  api_key="kind-e2e-key-7f3a9c"
  sha256() { printf %s "$1" | sha256sum | cut -d' ' -f1; }
  endpoint_up() {  # url, API key or "" for none: wait for the unknown request's 404; a 503 is not up yet
    local code="" header=()
    [ -n "$2" ] && header=(-H "Authorization: Bearer $2")
    for _ in $(seq 60); do
      code="$(curl -s -m 5 -o /tmp/probe.json -w '%{http_code}' "${header[@]}" "$1/status/e2e")"
      [ "${code}" = 404 ] && return 0
      sleep 2
    done
    if [ "${code}" = 503 ] && grep -q auth.not_ready /tmp/probe.json; then
      echo "still 503 auth.not_ready: $(cat /tmp/probe.json)"
    else
      echo "last answer ${code}: $(cat /tmp/probe.json 2>/dev/null)"
    fi
    return 1
  }
  kubernetes_block() {  # deployment folder, namespace: deploy it to that namespace
    sed -i 's/^target: docker$/target: kubernetes/' "$1/workflow_group.yaml"
    printf 'kubernetes:\n  namespace: %s\n  registry: %s\n' "$2" "${REGISTRY}" >> "$1/workflow_group.yaml"
  }

  cp -r /w/examples/helloworld /tmp/Target_Check
  kubernetes_block /tmp/Target_Check target-check

  log "deploy refuses an empty kubernetes: block"
  cp -r /w/examples/helloworld /tmp/Empty_Block
  sed -i 's/^target: docker$/target: kubernetes/' /tmp/Empty_Block/workflow_group.yaml
  printf 'kubernetes:\n  # namespace: later\n' >> /tmp/Empty_Block/workflow_group.yaml
  said="$(canyonos_in "${ADMIN_TOKEN}" /tmp/Empty_Block deploy helloworld 2>&1)" && fail "deploy passed an empty kubernetes: block"
  echo "${said}" | grep -q "kubernetes: section is missing or empty" \
    || fail "deploy did not name the empty kubernetes: block: ${said}"
  echo "${said}" | grep -qF "add one with \`namespace\` and \`registry\` to the workflow group's \`workflow_group.yaml\`" \
    || fail "deploy did not say what to add to the kubernetes: block: ${said}"

  log "a config that is not valid YAML is refused, not taken for a Docker project"
  cp -r /w/examples/helloworld /tmp/Bad_Yaml
  sed -i 's/^target: docker$/target: kubernetes/' /tmp/Bad_Yaml/workflow_group.yaml
  printf 'kubernetes: [\n' >> /tmp/Bad_Yaml/workflow_group.yaml
  said="$(canyonos_in "${ADMIN}" /tmp/Bad_Yaml stop 2>&1)" && fail "stop passed with a config that is not YAML: ${said}"
  echo "${said}" | grep -q "Could not read" || fail "stop did not say it could not read the config: ${said}"

  kubernetes_block /hw "${NS}"

  # The CanyonBuild is deleted once it succeeds: watch it while the deploy runs.
  as_deployer kubectl -n "${NS}" get canyonbuilds --watch -o yaml >/tmp/canyonbuilds.yaml 2>/dev/null &
  build_watch=$!
  canyonos deploy helloworld --api-key "${api_key}" || fail "deploy"
  kill "${build_watch}" 2>/dev/null || true

  log "The project takes the key's sha256, and the key itself never reached the cluster"
  grep -q "apiKeyHash: $(sha256 "${api_key}")" /tmp/canyonbuilds.yaml \
    || fail "the CanyonBuild carried no key hash: $(cat /tmp/canyonbuilds.yaml)"
  hash="$(as_deployer kubectl -n "${NS}" get canyonproject -o jsonpath='{.items[0].spec.auth.apiKeyHash}')"
  [ "${hash}" = "$(sha256 "${api_key}")" ] || fail "spec.auth.apiKeyHash is ${hash:-unset}, not the key's sha256"
  grep -qF "${api_key}" /tmp/canyonbuilds.yaml && fail "the CanyonBuild holds the API key"
  as_deployer kubectl -n "${NS}" get canyonproject -o yaml | grep -qF "${api_key}" \
    && fail "the CanyonProject holds the API key"
  record_of() {  # folder deployed from: the workflow_group.yaml of the record its deploy made
    /w/.venv/bin/python -c '
import glob, os, sys, yaml
inside = sys.argv[1].rstrip("/") + "/"
for path in glob.glob(os.path.expanduser("~/.canyonos/workflows/*/workflow_group.yaml")):
    workflows = (yaml.safe_load(open(path)) or {}).get("workflows") or {}
    if any(entry["path"].startswith(inside) for entry in workflows.values()):
        print(path)' "$1"
  }
  record="$(record_of /hw)"
  [ -n "${record}" ] || fail "the deploy made no record under ~/.canyonos/workflows for /hw"
  project_id="$(grep -E '^workflow_group_id:' "${record}" | awk '{print $2}')" \
    || fail "${record} has no workflow_group_id"
  workflow_in() {  # folder deployed from: the name the deploy gave its one workflow
    # The folder's name and the start of its workflow_id, as in helloworld-3f9a2c1b.
    /w/.venv/bin/python -c 'import sys, yaml; print(*yaml.safe_load(open(sys.argv[1]))["workflows"])' \
      "$(record_of "$1")"
  }
  workflow="$(workflow_in /hw)"
  [ -n "${workflow}" ] || fail "the deploy wrote no workflow to ${record}"
  # The dashboard's routes take the workflow's own id, never the workflow group's.
  workflow_id="$(/w/.venv/bin/python -c 'import sys, yaml; print(yaml.safe_load(open(sys.argv[1]))["workflows"][sys.argv[2]]["workflow_id"])' \
    "${record}" "${workflow}")"
  [ -n "${workflow_id}" ] || fail "the deploy wrote no workflow_id for ${workflow} to ${record}"
  # The deploy keeps the endpoint on 127.0.0.1:8080, as on Docker: an unknown request 404s.
  said="$(endpoint_up http://127.0.0.1:8080 "${api_key}")" \
    || fail "the endpoint is not forwarded to 127.0.0.1:8080: ${said}"

  log "The endpoint refuses a request with no key or another one"
  code="$(curl -s -m 5 -o /tmp/refused.json -w '%{http_code}' http://127.0.0.1:8080/status/e2e)"
  [ "${code}" = 401 ] && grep -q auth.missing_key /tmp/refused.json \
    || fail "no key answered ${code}: $(cat /tmp/refused.json)"
  code="$(curl -s -m 5 -o /tmp/refused.json -w '%{http_code}' -H "Authorization: Bearer not-${api_key}" \
    http://127.0.0.1:8080/status/e2e)"
  [ "${code}" = 401 ] && grep -q auth.invalid_key /tmp/refused.json \
    || fail "another key answered ${code}: $(cat /tmp/refused.json)"

  log "The endpoint answers an unknown request at once: no dashboard database to look it up in"
  took="$(curl -s -m 10 -o /dev/null -w '%{http_code} %{time_total}' -H "Authorization: Bearer ${api_key}" \
    http://127.0.0.1:8080/status/never-sent)"
  [ "${took%% *}" = 404 ] && awk -v s="${took##* }" 'BEGIN { exit !(s < 1) }' \
    || fail "an unknown request answered ${took} (status, seconds); it should be a 404 in under a second"

  canyonos status || fail "status"
  canyonos status --json | python -c 'import sys, json; json.load(sys.stdin)' \
    || fail "status --json is not JSON"
  canyonos doctor || fail "doctor"
  canyonos logs --no-follow --tail 5 >/dev/null || fail "logs"
  canyonos logs "${workflow}.HelloAgent-0" --no-follow --tail 5 >/dev/null || fail "logs ${workflow}.HelloAgent-0"

  log "The endpoint stays on 127.0.0.1:8080 when its pod is replaced"
  selector="$(as_deployer kubectl -n "${NS}" get svc canyonos-endpoint \
    -o go-template='{{range $k, $v := .spec.selector}}{{$k}}={{$v}},{{end}}')"
  as_deployer kubectl -n "${NS}" delete pods -l "${selector%,}" --wait=true >/dev/null \
    || fail "could not delete the endpoint's pod"
  said="$(endpoint_up http://127.0.0.1:8080 "${api_key}")" \
    || fail "the endpoint forward did not come back after its pod was replaced: ${said}"
  as_deployer kubectl -n "${NS}" wait pods -l "${selector%,}" --for=condition=Ready --timeout=5m >/dev/null \
    || fail "the endpoint's new pod is not ready"

  requests() {  # with the API key
    # kubectl itself in the background, not a function's subshell, so the kill below stops
    # it and the next call's forward can take the port.
    KUBECONFIG="${DEPLOYER}" kubectl -n "${NS}" port-forward svc/canyonos-endpoint 18080:8080 >/dev/null 2>&1 &
    local forward=$! ok=0 id sent answer
    endpoint_up http://127.0.0.1:18080 "${api_key}" || { kill "${forward}"; return 1; }
    for n in 1 2 3 4 5; do
      sent="$(curl -s -m 10 -w ' %{http_code}' -X POST http://127.0.0.1:18080/${workflow}/Workflow/main \
        -H "Authorization: Bearer ${api_key}" -H 'Content-Type: application/json' \
        -d "{\"query\": \"e2e ${n}\"}" || true)"
      id="$(echo "${sent% *}" | python -c 'import sys, json; print(json.load(sys.stdin)["request_id"])' 2>/dev/null || true)"
      [ -n "${id}" ] || echo "request ${n} answered ${sent}"
      for _ in $(seq 60); do
        answer="$(curl -s -m 5 -H "Authorization: Bearer ${api_key}" "http://127.0.0.1:18080/status/${id}" || true)"
        case "${answer}" in *'"done"'*) ok=$((ok + 1)); break ;; esac
        sleep 0.5
      done
      case "${answer}" in *'"done"'*) ;; *) echo "request ${n} last status: ${answer}" ;; esac
    done
    kill "${forward}" 2>/dev/null || true
    echo "requests done: ${ok}/5"
    [ "${ok}" = 5 ]
  }
  query_status() {  # API key: the status a POST of one query answers with
    curl -s -m 10 -o /tmp/query.json -w '%{http_code}' -X POST http://127.0.0.1:8080/${workflow}/Workflow/main \
      -H "Authorization: Bearer $1" -H 'Content-Type: application/json' -d '{"query": "e2e"}'
  }
  log "Requests through the endpoint"
  requests || fail "requests"

  log "The endpoint serves the workflow at /<workflow_id> too, the URL status gives, as on Docker"
  code="$(curl -s -m 10 -o /tmp/by-id.json -w '%{http_code}' -X POST "http://127.0.0.1:8080/${workflow_id}" \
    -H "Authorization: Bearer ${api_key}" -H 'Content-Type: application/json' -d '{"query": "by id"}')"
  [ "${code}" = 202 ] || fail "POST /${workflow_id} answered ${code}: $(cat /tmp/by-id.json)"
  id="$(python -c 'import json; print(json.load(open("/tmp/by-id.json"))["request_id"])')"
  answer=""
  for _ in $(seq 60); do
    answer="$(curl -s -m 5 -H "Authorization: Bearer ${api_key}" "http://127.0.0.1:8080/status/${id}")"
    case "${answer}" in *'"done"'*) break ;; esac
    sleep 0.5
  done
  echo "${answer}" | grep -q "Hello, by id! I'm the HelloAgent!" || fail "POST /${workflow_id} answered: ${answer}"
  canyonos status --json | grep -q "\"url\": \"[^\"]*/${workflow_id}\"" \
    || fail "status gives no /${workflow_id} URL: $(canyonos status --json | grep '"url"')"

  log "One workflow group per namespace: another is refused, and the first keeps running"
  project="$(as_deployer kubectl -n "${NS}" get canyonprojects -o jsonpath='{.items[0].metadata.name}')"
  first() {  # the first workflow group's CanyonProject and Redis pod, and its config's version
    as_deployer kubectl -n "${NS}" get "canyonproject/${project}" pod/canyonos-redis-0 \
      -o jsonpath='{range .items[*]}{.metadata.uid} {end}'
    as_deployer kubectl -n "${NS}" get "configmap/${project}-config" -o jsonpath='{.metadata.resourceVersion}'
  }
  before="$(first)"
  refused() {  # workflow group folder: its deploy into ${NS} fails at once, naming the one there
    local start="${SECONDS}" said
    said="$(canyonos_in "${DEPLOYER}" "$1" deploy helloworld --serve false --yes 2>&1)" \
      && fail "a second workflow group deployed into ${NS}: ${said}"
    echo "${said}" | grep -q "already runs the workflow group" || fail "the refusal did not say why: ${said}"
    [ $((SECONDS - start)) -lt 180 ] || fail "the refusal took $((SECONDS - start)) s"
  }
  cp -r /w/examples/helloworld /Second
  kubernetes_block /Second "${NS}"
  refused /Second
  # A folder of the first one's name: its objects would have the first one's names.
  mkdir -p /other && cp -r /w/examples/helloworld /other/hw
  kubernetes_block /other/hw "${NS}"
  refused /other/hw
  canyonos_in "${DEPLOYER}" /other/hw stop >/dev/null || fail "stop of the refused workflow group"
  # A CanyonProject applied by hand: the operator gives it NamespaceInUse, and nothing else.
  # Its route's workflowID is upper case, which the CanyonOS API takes on Docker too.
  as_deployer kubectl -n "${NS}" apply -f - >/dev/null <<EOF || fail "the cluster refused an upper-case workflowID"
apiVersion: canyonos.canyoncode.ai/v1alpha1
kind: CanyonProject
metadata: {name: e2e-second}
spec:
  projectID: 00000000-0000-4000-8000-0000000000e2
  configRef: e2e-second
  endpoint: {routes: [{workflow: second, workflowID: 6F1E2D3C-0000-4000-8000-0000000000E2, agent: Workflow, method: main}]}
EOF
  reason=""
  for _ in $(seq 30); do
    reason="$(as_deployer kubectl -n "${NS}" get canyonproject e2e-second \
      -o jsonpath='{.status.conditions[?(@.type=="Ready")].reason}')"
    [ "${reason}" = NamespaceInUse ] && break
    sleep 2
  done
  [ "${reason}" = NamespaceInUse ] || fail "a second CanyonProject reports ${reason:-nothing}, not NamespaceInUse"
  as_deployer kubectl -n "${NS}" delete canyonproject e2e-second --timeout=60s >/dev/null \
    || fail "the second CanyonProject was not deleted"
  [ "$(first)" = "${before}" ] || fail "the first workflow group changed: ${before} -> $(first)"
  requests || fail "requests after another workflow group was refused"

  log "canyonos test sends this machine's API key and never shows it"
  said="$(canyonos test 2>&1)" || fail "canyonos test: ${said}"
  echo "${said}" | grep -qF "${api_key}" && fail "canyonos test showed the API key: ${said}"

  log "The dashboard lists the project, reads its Redis and receives its telemetry"
  for _ in $(seq 30); do
    as_admin kubectl -n canyonos-dashboard get secret canyonos-dashboard-projects \
      -o jsonpath='{.data.projects\.json}' 2>/dev/null | base64 -d | grep -q "${project_id}" && break
    sleep 2
  done
  # operator.sh installs the chart with --set dashboard.apiKeyHash, this machine's key's
  # sha256 (/kube/dashboard-key), which the chart keeps in its Secret.
  dashboard_key="$(cat /kube/dashboard-key)"
  chart_hash="$(as_admin kubectl -n canyonos-dashboard get secret canyonos-dashboard -o jsonpath='{.data.api-key-hash}' | base64 -d)"
  [ "${chart_hash}" = "$(sha256 "${dashboard_key}")" ] \
    || fail "the chart's Secret holds ${chart_hash:-no api-key-hash}, not the dashboard key's sha256"
  # The API takes the key from that Secret when it starts, and finds the workflow groups
  # running on the cluster again from their CanyonProjects.
  as_admin kubectl -n canyonos-dashboard rollout restart deploy/canyonos-dashboard-api >/dev/null
  as_admin kubectl -n canyonos-dashboard rollout status deploy/canyonos-dashboard-api --timeout=5m >/dev/null \
    || fail "the CanyonOS API did not restart"
  restored=""
  for _ in $(seq 30); do
    said="$(canyonos status --json 2>/dev/null)" || true
    if echo "${said}" | python -c 'import sys, json; sys.exit(not json.load(sys.stdin)["running"])' 2>/dev/null; then
      restored=1
      break
    fi
    sleep 2
  done
  [ -n "${restored}" ] || fail "the restarted CanyonOS API lost the running workflow group: ${said}"
  # A port-forward ends with its pod: the forward opens again until it is stopped.
  (
    trap 'kill "${child:-}" 2>/dev/null; exit 0' TERM
    while true; do
      KUBECONFIG="${ADMIN}" kubectl -n canyonos-dashboard port-forward svc/canyonos-dashboard-api 18081:3000 >/dev/null 2>&1 &
      child=$!
      wait "${child}" || true
      sleep 1
    done
  ) &
  dashboard_forward=$!
  api="http://127.0.0.1:18081"
  api_call() {  # method, path, API key or "", JSON body or nothing: the status; the body in /tmp/api.json
    local code="" header=() body=()
    [ -n "$3" ] && header=(-H "Authorization: Bearer $3")
    [ -n "${4:-}" ] && body=(-H 'Content-Type: application/json' -d "$4")
    for _ in $(seq 30); do  # 000 while the forward opens again
      code="$(curl -s -m 10 -o /tmp/api.json -w '%{http_code}' -X "$1" "${header[@]}" "${body[@]}" "${api}$2")"
      [ "${code}" != 000 ] && break
      sleep 2
    done
    echo "${code}"
  }

  log "The dashboard's API verifies the key"
  code="$(api_call GET /v1/auth/status "")"
  [ "${code}" = 200 ] && python -c 'import json, sys; sys.exit(json.load(open("/tmp/api.json")) != {"api_key_required": True})' \
    || fail "/v1/auth/status answered ${code}: $(cat /tmp/api.json)"
  code="$(api_call GET /v1/workflows "")"
  [ "${code}" = 401 ] && grep -q auth.missing_key /tmp/api.json \
    || fail "/v1/workflows with no key answered ${code}: $(cat /tmp/api.json)"
  code="$(api_call GET /v1/workflows "not-${dashboard_key}")"
  [ "${code}" = 401 ] && grep -q auth.invalid_key /tmp/api.json \
    || fail "/v1/workflows with another key answered ${code}: $(cat /tmp/api.json)"
  code="$(api_call GET /v1/auth/check "${dashboard_key}")"
  [ "${code}" = 200 ] || fail "/v1/auth/check with the key answered ${code}: $(cat /tmp/api.json)"
  # The chart runs the API without Docker: ready means its database is, and Docker is off.
  code="$(api_call GET /v1/readyz "")"
  [ "${code}" = 200 ] && python -c 'import json, sys; sys.exit(json.load(open("/tmp/api.json"))["checks"] != {"database": "ok", "docker": "disabled"})' \
    || fail "/v1/readyz answered ${code}: $(cat /tmp/api.json)"
  get() { curl -s -m 10 -H "Authorization: Bearer ${dashboard_key}" "${api}$1"; }
  until_found() {  # path, text, what
    for _ in $(seq 40); do get "$1" | grep -q "$2" && return 0; sleep 5; done
    fail "$3: $(get "$1")"
  }
  until_found /v1/workflows "${workflow_id}" "the dashboard does not list the project's workflow"
  get /v1/workflows | python -c 'import sys, json; sys.exit(sys.argv[1] in {w["id"] for w in json.load(sys.stdin)})' \
    "${project_id}" || fail "the dashboard lists the workflow group ${project_id} as a workflow: $(get /v1/workflows)"
  code="$(api_call GET "/v1/workflow-groups/${project_id}/workflows/${workflow_id}/scaling" "${dashboard_key}")"
  [ "${code}" = 200 ] || fail "reading scaling answered ${code}: $(cat /tmp/api.json)"
  # One replica, as helloworld runs: the policy changes nothing, and goes right after.
  policy='{"min_replicas": 1, "max_replicas": 1, "metric": "queue_length_total", "scale_up_above": 10, "scale_down_below": 1}'
  code="$(api_call PUT "/v1/workflow-groups/${project_id}/workflows/${workflow_id}/scaling" "${dashboard_key}" "${policy}")"
  [ "${code}" = 200 ] || fail "saving a scaling policy answered ${code}: $(cat /tmp/api.json)"
  code="$(api_call DELETE "/v1/workflow-groups/${project_id}/workflows/${workflow_id}/scaling" "${dashboard_key}")"
  [ "${code}" = 200 ] || fail "deleting the scaling policy answered ${code}: $(cat /tmp/api.json)"

  until_found "/v1/workflow-groups/${project_id}/workflows/${workflow_id}/monitoring/endpoint" "canyonos-endpoint.${NS}.svc" \
    "the dashboard could not read the project's Redis"
  until_found "/v1/workflow-groups/${project_id}/workflows/${workflow_id}/monitoring/replicas" '"replica":' "no telemetry reached the dashboard"
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
  until_found "/v1/workflow-groups/${project_id}/workflows/${workflow_id}/monitoring/endpoint" "canyonos-endpoint.${NS}.svc" \
    "the dashboard lost the project's Redis after the rotation"

  log "A deploy with a new key refuses the old one"
  old_key="${api_key}"
  api_key="kind-e2e-key-b81d2e"
  canyonos deploy helloworld --api-key "${api_key}" || fail "deploy with a new key"
  refused=""
  for _ in $(seq 60); do
    if [ "$(query_status "${old_key}")" = 401 ]; then
      refused=1
      break
    fi
    sleep 5
  done
  [ -n "${refused}" ] && grep -q auth.invalid_key /tmp/query.json \
    || fail "the old key still answers: $(cat /tmp/query.json)"
  code="$(query_status "${api_key}")"
  [ "${code}" = 202 ] || fail "the new key answered ${code}: $(cat /tmp/query.json)"
  kill "${dashboard_forward}" 2>/dev/null || true

  log "canyonos serve keeps the dashboard on 127.0.0.1:8081 and returns"
  # As an admin: the deployer may port-forward only to the CanyonOS API there, and serve
  # reads the dashboard's web Service first.
  canyonos_in "${ADMIN}" /hw serve || fail "serve"
  curl -sf -m 5 -o /dev/null http://127.0.0.1:8081/ || fail "the dashboard is not on 127.0.0.1:8081"

  log "another project's serve keeps the running dashboard on its port"
  printf 'dashboard_port: 9000\n' >> /tmp/Target_Check/workflow_group.yaml
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
  canyonos deploy helloworld || fail "deploy again"
  canyonos_in "${ADMIN}" /hw serve || fail "serve again"
  said="$(endpoint_up http://127.0.0.1:8080 "${api_key}")" \
    || fail "the redeploy did not forward the endpoint to 127.0.0.1:8080: ${said}"
  curl -sf -m 5 -o /dev/null http://127.0.0.1:8081/ || fail "serve did not open the dashboard again"

  log "deploy --no-api-key opens the endpoint"
  canyonos deploy helloworld --no-api-key || fail "deploy --no-api-key"
  hash="$(as_deployer kubectl -n "${NS}" get canyonproject -o jsonpath='{.items[0].spec.auth.apiKeyHash}')"
  [ -z "${hash}" ] || fail "spec.auth.apiKeyHash is ${hash}, not unset"
  said="$(endpoint_up http://127.0.0.1:8080 "")" \
    || fail "the endpoint does not answer a request with no key once deployed without one: ${said}"

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

  log "Two workflows in a workflow group: a code change rolls out only the changed one's agents"
  mkdir -p /multi && cp /w/examples/helloworld/workflow_group.yaml /multi/ && kubernetes_block /multi "${NS}"
  cp -r /w/examples/helloworld/helloworld /alpha
  cp -r /w/examples/helloworld/helloworld /beta
  multi() {  # workflow folders: deploy the workflow group /multi with them, with the API key
    (cd /multi && KUBECONFIG="${DEPLOYER}" CANYONOS_API_KEY="${api_key}" COLUMNS=200 timeout 600 \
      /w/.venv/bin/canyonos deploy "$@" --serve false --yes </dev/null)
  }
  multi ../alpha ../beta || fail "the deploy of two workflows"
  recorded() {  # workflow folder: its workflow group's record and the workflow's name there
    /w/.venv/bin/python -c '
import glob, os, sys, yaml
for path in glob.glob(os.path.expanduser("~/.canyonos/workflows/*/workflow_group.yaml")):
    workflows = (yaml.safe_load(open(path)) or {}).get("workflows") or {}
    for name, entry in workflows.items():
        if os.path.abspath(entry["path"]) == sys.argv[1]:
            print(os.path.basename(os.path.dirname(path)), name)' "$1"
  }
  read -r group alpha <<< "$(recorded /alpha)"
  read -r _ beta <<< "$(recorded /beta)"
  [ -n "${group}" ] && [ -n "${alpha}" ] && [ -n "${beta}" ] \
    || fail "the deploy recorded no workflows: $(cat ~/.canyonos/workflows/*/workflow_group.yaml)"
  pods_of() {  # workflow: its pods, as name=uid
    as_deployer kubectl -n "${NS}" get pods \
      -o jsonpath='{range .items[*]}{.metadata.name}={.metadata.uid}{"\n"}{end}' | grep "^$1-" | sort
  }
  shared() {  # the workflow group's CanyonProject and Redis pod, which a code change keeps
    as_deployer kubectl -n "${NS}" get canyonproject/multi pod/canyonos-redis-0 \
      -o jsonpath='{range .items[*]}{.metadata.uid} {end}'
  }
  KUBECONFIG="${DEPLOYER}" kubectl -n "${NS}" port-forward svc/canyonos-endpoint 18090:8080 >/dev/null 2>&1 &
  multi_forward=$!
  endpoint_up http://127.0.0.1:18090 "${api_key}" >/dev/null || fail "the workflow group's endpoint is not up"
  (
    ok=0 failed=0
    while [ ! -f /tmp/stop-poll ]; do
      code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:18090/${beta}/Workflow/main" \
        -H "Authorization: Bearer ${api_key}" -H 'Content-Type: application/json' -d '{"query": "beta"}' || true)"
      if [ "${code}" = 202 ]; then ok=$((ok + 1)); else failed=$((failed + 1)); fi
      sleep 1
    done
    echo "${ok} ${failed}" > /tmp/poll.txt
  ) &
  poller=$!
  shared_before="$(shared)"
  alpha_before="$(pods_of "${alpha}")"
  beta_before="$(pods_of "${beta}")"
  echo "# a code change" >> /alpha/agents/hello_agent.py
  multi ../alpha ../beta || fail "the redeploy of a code change in ${alpha}"
  touch /tmp/stop-poll
  wait "${poller}" || true
  rm -f /tmp/stop-poll
  read -r ok failed < /tmp/poll.txt
  [ "$(shared)" = "${shared_before}" ] || fail "a code change replaced the CanyonProject or Redis"
  [ "$(pods_of "${beta}")" = "${beta_before}" ] || fail "a code change in ${alpha} replaced ${beta}'s pods"
  [ "$(pods_of "${alpha}")" != "${alpha_before}" ] || fail "${alpha}'s new code did not replace its pods"
  [ "${failed}" = 0 ] && [ "${ok}" -gt 0 ] \
    || fail "${beta} failed ${failed} of $((ok + failed)) requests while ${alpha} rolled out"
  echo "${beta} answered all ${ok} requests while ${alpha} rolled out"

  log "A code change rolls out after the deploy hands it over: --detach returns while it rolls"
  multi_phase() {  # run from one of its workflow folders, as commands find a workflow group
    canyonos_in "${DEPLOYER}" /alpha status --json 2>/dev/null \
      | /w/.venv/bin/python -c 'import sys, json; print(json.load(sys.stdin).get("phase"))' || true
  }
  echo "# another code change" >> /beta/agents/hello_agent.py
  multi ../alpha ../beta --detach || fail "the detached redeploy of a code change in ${beta}"
  phase="$(multi_phase)"
  [ "${phase}" = starting ] || fail "deploy --detach returned once the rollout was ${phase}, not while it ran"
  for _ in $(seq 150); do
    phase="$(multi_phase)"
    [ "${phase}" = up ] || [ "${phase}" = failed ] && break
    sleep 2
  done
  [ "${phase}" = up ] || fail "the detached rollout ended ${phase}: $(canyonos_in "${DEPLOYER}" /alpha status 2>&1)"

  log "Deploying one of the two workflows takes the other out, and nothing else"
  alpha_before="$(pods_of "${alpha}")"
  # Named: without a name, a deploy of other folders than a record's makes another one.
  multi ../alpha --workflow-group "${group}" || fail "the deploy of ${alpha} alone"
  [ "$(shared)" = "${shared_before}" ] || fail "taking ${beta} out replaced the CanyonProject or Redis"
  [ "$(pods_of "${alpha}")" = "${alpha_before}" ] || fail "taking ${beta} out replaced ${alpha}'s pods"
  for _ in $(seq 120); do
    left="$(as_deployer kubectl -n "${NS}" get canyonagents,pods -o name | grep "/${beta}-" || true)"
    [ -z "${left}" ] && break
    sleep 2
  done
  [ -z "${left}" ] || fail "${beta} is still running: ${left}"
  as_deployer kubectl -n "${NS}" get secrets -l canyonos.canyoncode.ai/project=multi -o name | grep -q "${beta}" \
    && fail "${beta}'s .env Secret is left behind"
  kill "${multi_forward}" 2>/dev/null || true
  canyonos_in "${DEPLOYER}" /alpha stop >/dev/null || fail "stop of the workflow group of two workflows"

  log "deploy_mode: toy runs the project as one agent StatefulSet, which answers"
  cp -r /w/examples/helloworld /toy
  printf 'deploy_mode: toy\n' >> /toy/workflow_group.yaml
  kubernetes_block /toy "${NS}"
  # CANYONOS_API_KEY sets this deploy's key without saving it.
  (cd /toy && KUBECONFIG="${DEPLOYER}" CANYONOS_API_KEY="${api_key}" /w/.venv/bin/canyonos deploy helloworld) \
    || fail "toy deploy"
  workflow="$(workflow_in /toy)"
  [ -n "${workflow}" ] || fail "the toy deploy wrote no workflow to its record"
  [ "$(as_deployer kubectl -n "${NS}" get canyonagents -o name)" = "canyonagent.canyonos.canyoncode.ai/${workflow}-toy" ] \
    && [ "$(as_deployer kubectl -n "${NS}" get statefulsets -l canyonos.canyoncode.ai/agent -o name)" = "statefulset.apps/${workflow}-toy" ] \
    && as_deployer kubectl -n "${NS}" get statefulset endpoint >/dev/null \
    || fail "toy runs: $(as_deployer kubectl -n "${NS}" get canyonagents,statefulsets -o name)"
  said="$(endpoint_up http://127.0.0.1:8080 "${api_key}")" || fail "the toy endpoint is not up with its key: ${said}"
  id="$(curl -s -m 10 -X POST http://127.0.0.1:8080/${workflow}/Workflow/main -H "Authorization: Bearer ${api_key}" \
    -H 'Content-Type: application/json' -d '{"query": "toy"}' | python -c 'import sys, json; print(json.load(sys.stdin)["request_id"])')" || fail "toy query"
  for _ in $(seq 60); do
    answer="$(curl -s -m 5 -H "Authorization: Bearer ${api_key}" "http://127.0.0.1:8080/status/${id}")"
    case "${answer}" in *'"done"'*) break ;; esac
    sleep 0.5
  done
  echo "${answer}" | grep -q "Hello, toy! I'm the HelloAgent!" || fail "toy answered: ${answer}"
  canyonos_in "${DEPLOYER}" /toy stop || fail "toy stop"

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
# The key operator.sh installed the dashboard with: this machine's.
if [ -n "${CANYONOS_API_KEY:-}" ]; then
  printf %s "${CANYONOS_API_KEY}" > "${kube}/dashboard-key"
else
  tr -d '\r\n' < "${HOME}/.canyonos/api_key" > "${kube}/dashboard-key"
fi
git -C "${REPO}" ls-files -co --exclude-standard -z > "${kube}/files"
docker run --rm --network kind \
  -v "${REPO}:/src:ro" -v "$(cd "${kube}" && { pwd -W 2>/dev/null || pwd; }):/kube:ro" \
  python:3.12-slim bash /src/scripts/kind/e2e.sh --inside
