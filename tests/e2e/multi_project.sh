#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

# Runs two projects side by side on one machine with the shared dashboard:
# helloworld and the portfolio fixture are deployed at the same time, each on
# its own ports, and the dashboard must list both and read each one's Redis.
# Then one project is stopped, the other keeps answering, the stopped one
# redeployed without `endpoint.api_port` or `redis.port` moves past the
# other's 8080 and 6379 and warns that the running dashboard ignores its
# `dashboard_port`, `canyonos serve` from the other re-registers without
# recreating the api, a redeploy of it keeps the dashboard, the last stop
# stops the dashboard while keeping its containers, `canyonos serve` refuses
# a taken `dashboard_port`, and with 8080 held and no dashboard up, the
# endpoint and the dashboard starting with it end up on different ports.
#
# Usage: tests/e2e/multi_project.sh
#
# The portfolio project deploys without Bedrock access; AWS_ACCESS_KEY_ID and
# AWS_SECRET_ACCESS_KEY are passed through when set and faked otherwise, since
# nothing here sends it a query. Logs land in $E2E_ARTIFACTS_DIR (default: a
# temp directory printed at the end).

set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$E2E_DIR/../.." && pwd)"
API_URL="http://127.0.0.1:3000"
DASHBOARD_DB="canyonos-dashboard-db-1"
DASHBOARD_API="canyonos-dashboard-api-1"
REDIS_ROUTES="prompts scaling/agents monitoring/replicas monitoring/endpoint"

if [ -f "$E2E_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$E2E_DIR/.env"
  set +a
fi

# The images are built from this checkout, here or by CI, which names them in CANYONOS_*_IMAGE.
export CANYONOS_ENV=development
export CANYONOS_CORE_IMAGE="${CANYONOS_CORE_IMAGE:-local}"
export CANYONOS_API_IMAGE="${CANYONOS_API_IMAGE:-local}"
export CANYONOS_WEB_IMAGE="${CANYONOS_WEB_IMAGE:-local}"

WORK_DIR="$(mktemp -d)"
ARTIFACTS_DIR="${E2E_ARTIFACTS_DIR:-$(mktemp -d)}"
mkdir -p "$ARTIFACTS_DIR"

canyonos() { uv run --project "$REPO_ROOT" canyonos "$@"; }
step() { printf '\n==> %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

collect_logs() {
  step "Collecting container logs into $ARTIFACTS_DIR"
  local name
  for name in $(docker ps -a --filter name=canyonos --format '{{.Names}}'); do
    docker logs "$name" >"$ARTIFACTS_DIR/$name.log" 2>&1 || true
  done
}

finish() {
  local status=$?
  collect_logs
  (cd "$WORK_DIR/helloworld" && canyonos stop) || true
  (cd "$WORK_DIR/portfolio" && canyonos stop) || true
  (cd "$WORK_DIR/twin/helloworld" && canyonos stop) || true
  docker compose -p canyonos-dashboard down --remove-orphans >/dev/null 2>&1 || true
  if [ "$status" -eq 0 ]; then
    step "PASS: multi-project"
  else
    step "FAIL: multi-project (logs in $ARTIFACTS_DIR)"
  fi
  exit "$status"
}
trap finish EXIT

config_port() {
  (cd "$WORK_DIR/$1" && uv run --project "$REPO_ROOT" python -c \
    "from canyonos.constants import default_config_path, $2; print($2(default_config_path()))")
}

api() {
  local method="$1" path="$2" body="${3:-}" out="$ARTIFACTS_DIR/api-response.json"
  curl -s -o "$out" -w '%{http_code}' -X "$method" "$API_URL$path" \
    ${TOKEN:+-H "Authorization: Bearer $TOKEN"} -H "Content-Type: application/json" \
    ${body:+-d "$body"}
}

project_names() {
  python3 -c 'import json, sys; print(" ".join(sorted(p["name"] for p in json.load(sys.stdin))))' \
    <"$ARTIFACTS_DIR/api-response.json"
}

project_id() {
  python3 -c 'import json, sys; print(next(p["id"] for p in json.load(sys.stdin) if p["name"] == sys.argv[1]))' \
    "$1" <"$ARTIFACTS_DIR/api-response.json"
}

expect_routes() {
  local project="$1" id="$2" expected="$3" route code
  for route in $REDIS_ROUTES; do
    code="$(api GET "/projects/$id/$route")"
    [ "$code" = "$expected" ] || fail "$project $route answered $code, expected $expected"
  done
}

step "Staging helloworld and portfolio in $WORK_DIR"
cp -R "$REPO_ROOT/examples/helloworld" "$WORK_DIR/helloworld"
# Fixed so they can't race the portfolio fixture's api_port 8080 and Redis 6379 when both deploy at once.
perl -pi -e 's/^endpoint:$/endpoint:\n  api_port: 8082/; s/^redis:$/redis:\n  port: 6380/' \
  "$WORK_DIR/helloworld/config/global_controller.yaml"
cp -R "$REPO_ROOT/examples/portfolio" "$WORK_DIR/portfolio"
cp -R "$E2E_DIR/portfolio/.canyon" "$WORK_DIR/portfolio/.canyon"
cat >"$WORK_DIR/portfolio/.env" <<EOF
AWS_ENDPOINT_URL_BEDROCK_RUNTIME=http://127.0.0.1:8081/bedrock
AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:-not-a-real-key}
AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY:-not-a-real-secret}
AWS_REGION=us-east-1
EOF
HELLO_REDIS="$(config_port helloworld local_redis_port)"
PORTFOLIO_REDIS="$(config_port portfolio local_redis_port)"
HELLO_API="http://127.0.0.1:$(config_port helloworld endpoint_api_port)"
[ "$HELLO_REDIS" != "$PORTFOLIO_REDIS" ] || fail "both projects use Redis port $HELLO_REDIS"

step "Building the images set to local"
if [ "$CANYONOS_CORE_IMAGE" = local ]; then
  docker build -q -f "$REPO_ROOT/packages/core/Dockerfile" -t canyonos-core:dev "$REPO_ROOT/packages/core"
fi
if [ "$CANYONOS_API_IMAGE" = local ]; then
  docker build -q -f "$REPO_ROOT/packages/api/Dockerfile" -t canyonos-api:dev "$REPO_ROOT"
fi
if [ "$CANYONOS_WEB_IMAGE" = local ]; then
  docker build -q -f "$REPO_ROOT/packages/web/Dockerfile" --target canyonos \
    --build-arg VITE_API_URL=/api \
    -t canyonos-web:dev "$REPO_ROOT"
fi

step "canyonos stop (any previous deploy of either project)"
(cd "$WORK_DIR/helloworld" && canyonos stop) || true
(cd "$WORK_DIR/portfolio" && canyonos stop) || true

# With no TTY on stdin, deploy fills in default resources instead of opening the
# resource picker. Both deploys run at once: the dashboard lock has to serialise
# their `serve`, and each must register its own project.
step "canyonos deploy helloworld and portfolio at the same time"
(cd "$WORK_DIR/helloworld" && canyonos deploy </dev/null >"$ARTIFACTS_DIR/deploy-helloworld.log" 2>&1) &
hello_pid=$!
(cd "$WORK_DIR/portfolio" && canyonos deploy </dev/null >"$ARTIFACTS_DIR/deploy-portfolio.log" 2>&1) &
portfolio_pid=$!
wait "$hello_pid" || { cat "$ARTIFACTS_DIR/deploy-helloworld.log"; fail "helloworld deploy failed"; }
wait "$portfolio_pid" || { cat "$ARTIFACTS_DIR/deploy-portfolio.log"; fail "portfolio deploy failed"; }
grep -q "Registered helloworld with the dashboard" "$ARTIFACTS_DIR/deploy-helloworld.log" ||
  fail "helloworld did not register with the dashboard"
grep -q "Registered portfolio with the dashboard" "$ARTIFACTS_DIR/deploy-portfolio.log" ||
  fail "portfolio did not register with the dashboard"

step "Each container sits in its project's Docker group"
docker ps --format '{{.Names}}\t{{.Label "com.docker.compose.project"}}' | sort | tee "$ARTIFACTS_DIR/groups.txt"
grep -qE 'canyonos-helloworld-[0-9a-f]{8}-global-controller.canyonos-helloworld-[0-9a-f]{8}$' "$ARTIFACTS_DIR/groups.txt" ||
  fail "helloworld's Global Controller is missing or in the wrong group"
grep -qE 'canyonos-portfolio-[0-9a-f]{8}-global-controller.canyonos-portfolio-[0-9a-f]{8}$' "$ARTIFACTS_DIR/groups.txt" ||
  fail "portfolio's Global Controller is missing or in the wrong group"
[ "$(grep -c 'canyonos-dashboard$' "$ARTIFACTS_DIR/groups.txt")" = 3 ] || fail "expected one dashboard stack of three containers"
API_CREATED="$(docker inspect -f '{{.Created}}' "$DASHBOARD_API")"

step "The dashboard lists both projects with their own Redis ports"
[ "$(api GET /auth/status)" = 200 ] || fail "GET /auth/status failed"
auth_mode="$(python3 -c 'import json, sys; print(json.load(sys.stdin)["mode"])' <"$ARTIFACTS_DIR/api-response.json")"
# With AUTH_MODE=none, the default, every route answers without a token.
if [ "$auth_mode" = password ]; then
  E2E_CREDENTIALS='"email":"e2e@canyonos.test","password":"e2e-password-1"'
  registered="$(api POST /auth/register "{$E2E_CREDENTIALS,\"password_confirmation\":\"e2e-password-1\"}")"
  if [ "$registered" = 403 ]; then
    [ "$(api POST /auth/login "{$E2E_CREDENTIALS}")" = 200 ] || fail "login failed"
  else
    [ "$registered" = 201 ] || fail "registration failed with HTTP $registered"
  fi
  TOKEN="$(python3 -c 'import json, sys; print(json.load(sys.stdin)["token"])' <"$ARTIFACTS_DIR/api-response.json")"
fi
[ "$(api GET /projects)" = 200 ] || fail "GET /projects failed"
[ "$(project_names)" = "helloworld portfolio" ] || fail "projects listed: $(project_names)"
HELLO_ID="$(project_id helloworld)"
PORTFOLIO_ID="$(project_id portfolio)"
stored="$(docker exec "$DASHBOARD_DB" psql -U canyonos -tA -c "select name || ':' || redis_port from projects order by name" | tr '\n' ' ')"
[ "$stored" = "helloworld:$HELLO_REDIS portfolio:$PORTFOLIO_REDIS " ] || fail "projects table holds: $stored"

step "Prompts, scaling and monitoring answer for each project from its own Redis"
expect_routes helloworld "$HELLO_ID" 200
expect_routes portfolio "$PORTFOLIO_ID" 200
api GET "/projects/$PORTFOLIO_ID/scaling/agents" >/dev/null
grep -q '"name":"AdvisorAgent","replicas_expected":1,"replicas_running":1' "$ARTIFACTS_DIR/api-response.json" ||
  fail "portfolio's scaling agents do not come from its Redis: $(cat "$ARTIFACTS_DIR/api-response.json")"
api GET "/projects/$HELLO_ID/scaling/agents" >/dev/null
grep -q '"name":"HelloAgent","replicas_expected":1,"replicas_running":1' "$ARTIFACTS_DIR/api-response.json" ||
  fail "helloworld's scaling agents do not come from its Redis: $(cat "$ARTIFACTS_DIR/api-response.json")"

step "Query the helloworld endpoint at $HELLO_API"
python3 "$E2E_DIR/query.py" "$HELLO_API" main query hello 60 >"$ARTIFACTS_DIR/helloworld-result.json"
grep -q "greeting" "$ARTIFACTS_DIR/helloworld-result.json" || fail "helloworld returned no greeting"

step "canyonos test in another folder named helloworld tests that folder, not the running one"
mkdir "$WORK_DIR/twin"
cp -R "$REPO_ROOT/examples/helloworld" "$WORK_DIR/twin/helloworld"
(cd "$WORK_DIR/twin/helloworld" && canyonos test hello --json >"$ARTIFACTS_DIR/test-twin.json") ||
  { cat "$ARTIFACTS_DIR/test-twin.json"; fail "canyonos test failed in the second helloworld folder"; }
grep -q '"against_existing_deploy": false' "$ARTIFACTS_DIR/test-twin.json" ||
  fail "canyonos test in the second helloworld folder queried the first one's deploy"
python3 "$E2E_DIR/query.py" "$HELLO_API" main query hello 60 >"$ARTIFACTS_DIR/helloworld-result.json"
grep -q "greeting" "$ARTIFACTS_DIR/helloworld-result.json" || fail "the first helloworld stopped answering"

step "canyonos stop helloworld leaves portfolio and the dashboard"
(cd "$WORK_DIR/helloworld" && canyonos stop)
docker ps --format '{{.Names}}' | grep -q '^canyonos-helloworld-' && fail "helloworld containers survived stop"
compgen -G "$HOME/.canyonos/projects/helloworld-*/deployed.json" >/dev/null && fail "stop left helloworld's deployed.json behind"
[ "$(docker ps --format '{{.Names}}' | grep -c '^canyonos-dashboard-')" = 3 ] || fail "the dashboard did not survive helloworld's stop"
expect_routes portfolio "$PORTFOLIO_ID" 200
[ "$(api GET "/projects/$HELLO_ID/prompts")" = 502 ] || fail "a stopped project should read as unreachable"

step "helloworld without endpoint.api_port or redis.port moves past portfolio's ports"
sed -i.bak -e '/api_port:/d' -e '/^  port: 6380/d' "$WORK_DIR/helloworld/config/global_controller.yaml"
echo "dashboard_port: 8090" >>"$WORK_DIR/helloworld/config/global_controller.yaml"
(cd "$WORK_DIR/helloworld" && canyonos deploy </dev/null >"$ARTIFACTS_DIR/deploy-helloworld-free-port.log" 2>&1) ||
  { cat "$ARTIFACTS_DIR/deploy-helloworld-free-port.log"; fail "helloworld deploy without api_port failed"; }
grep -q "Port 8080 is taken, so the endpoint is on" "$ARTIFACTS_DIR/deploy-helloworld-free-port.log" ||
  fail "the deploy did not say where the endpoint moved"
grep -q "Port 6379 is taken, so Redis is on" "$ARTIFACTS_DIR/deploy-helloworld-free-port.log" ||
  fail "the deploy did not say where Redis moved"
expect_routes helloworld "$HELLO_ID" 200
grep -q 'The dashboard is already running on 8081, so `dashboard_port: 8090` is ignored.' \
  "$ARTIFACTS_DIR/deploy-helloworld-free-port.log" || fail "the deploy did not warn that dashboard_port 8090 is ignored"
FREE_API="http://127.0.0.1:$(cd "$WORK_DIR/helloworld" && uv run --project "$REPO_ROOT" python -c \
  'from canyonos.gc import deployed_endpoint; from canyonos.init import load_state; print(deployed_endpoint(load_state()["port"])["api_port"])')"
[ "$FREE_API" != "http://127.0.0.1:8080" ] || fail "helloworld's endpoint did not move off 8080"
python3 "$E2E_DIR/query.py" "$FREE_API" main query hello 60 >"$ARTIFACTS_DIR/helloworld-free-port-result.json"
grep -q "greeting" "$ARTIFACTS_DIR/helloworld-free-port-result.json" || fail "helloworld on $FREE_API returned no greeting"

step "helloworld's machine metrics go to its own Redis, not portfolio's"
FREE_REDIS="$(grep -o 'so Redis is on [0-9]*' "$ARTIFACTS_DIR/deploy-helloworld-free-port.log" | grep -o '[0-9]*$')"
HELLO_REDIS_CONTAINER="$(docker ps --format '{{.Names}}' | grep -E '^canyonos-helloworld-[0-9a-f]{8}-redis-localhost$')"
hello_metrics() { docker exec "$HELLO_REDIS_CONTAINER" redis-cli -p "$FREE_REDIS" exists machine:localhost:metrics; }
for _ in $(seq 15); do [ "$(hello_metrics)" = 1 ] && break; sleep 2; done
[ "$(hello_metrics)" = 1 ] || fail "no machine metrics in helloworld's Redis on $FREE_REDIS"
(cd "$WORK_DIR/helloworld" && canyonos stop)

step "canyonos serve from portfolio re-registers without recreating the api"
(cd "$WORK_DIR/portfolio" && canyonos serve) | tee "$ARTIFACTS_DIR/serve-portfolio.log"
grep -q "Registered portfolio with the dashboard" "$ARTIFACTS_DIR/serve-portfolio.log" || fail "serve did not re-register portfolio"
[ "$(docker inspect -f '{{.Created}}' "$DASHBOARD_API")" = "$API_CREATED" ] || fail "serve recreated the api container"

step "canyonos deploy portfolio again keeps the dashboard running"
(cd "$WORK_DIR/portfolio" && canyonos deploy </dev/null >"$ARTIFACTS_DIR/redeploy-portfolio.log" 2>&1) ||
  { cat "$ARTIFACTS_DIR/redeploy-portfolio.log"; fail "portfolio redeploy failed"; }
grep -q "Registered portfolio with the dashboard" "$ARTIFACTS_DIR/redeploy-portfolio.log" || fail "the redeploy did not re-register portfolio"
[ "$(docker inspect -f '{{.Created}}' "$DASHBOARD_API")" = "$API_CREATED" ] || fail "the redeploy recreated the api container"

step "The redeploy is the same dashboard project"
[ "$(api GET /projects)" = 200 ] || fail "GET /projects failed after the redeploy"
[ "$(project_names)" = "helloworld portfolio" ] || fail "projects listed after the redeploy: $(project_names)"
[ "$(project_id portfolio)" = "$PORTFOLIO_ID" ] || fail "portfolio changed id on redeploy: $(project_id portfolio) was $PORTFOLIO_ID"

step "canyonos stop portfolio stops the dashboard, keeping it"
(cd "$WORK_DIR/portfolio" && canyonos stop)
leftovers="$(docker ps -a --format '{{.Names}}' | grep -E '^canyonos-(helloworld|portfolio)-' || true)"
[ -z "$leftovers" ] || fail "containers left behind: $leftovers"
running="$(docker ps --format '{{.Names}}' | grep -E '^canyonos-dashboard-' || true)"
[ -z "$running" ] || fail "the dashboard is still running: $running"
[ "$(docker ps -a --format '{{.Names}}' | grep -c '^canyonos-dashboard-')" = 3 ] || fail "the stopped dashboard was removed"

step "canyonos serve refuses a taken dashboard_port"
python3 -m http.server 8090 >/dev/null 2>&1 &
holder=$!
sleep 1
if (cd "$WORK_DIR/helloworld" && canyonos serve) >"$ARTIFACTS_DIR/serve-taken-port.log" 2>&1; then
  kill "$holder"
  fail "serve started the dashboard on a taken dashboard_port"
fi
kill "$holder"
grep -q "Port 8090 is taken. Change \`dashboard_port\`, or remove it" "$ARTIFACTS_DIR/serve-taken-port.log" ||
  fail "serve did not say dashboard_port 8090 is taken: $(cat "$ARTIFACTS_DIR/serve-taken-port.log")"

step "With 8080 held, a deploy pinned to it stops before anything is built"
python3 -m http.server 8080 >/dev/null 2>&1 &
holder=$!
sleep 1
perl -pi -e 's/^endpoint:$/endpoint:\n  api_port: 8080/' "$WORK_DIR/helloworld/config/global_controller.yaml"
if (cd "$WORK_DIR/helloworld" && canyonos deploy </dev/null >"$ARTIFACTS_DIR/deploy-helloworld-pinned-8080.log" 2>&1); then
  kill "$holder"
  fail "helloworld deployed on a taken api_port"
fi
kill "$holder"
grep -q "Port 8080 is already in use" "$ARTIFACTS_DIR/deploy-helloworld-pinned-8080.log" ||
  fail "the deploy did not say 8080 is taken: $(cat "$ARTIFACTS_DIR/deploy-helloworld-pinned-8080.log")"
sed -i.bak '/api_port:/d' "$WORK_DIR/helloworld/config/global_controller.yaml"

step "With 8080 held and no dashboard up, the endpoint and the dashboard get their own ports"
sed -i.bak '/^dashboard_port:/d' "$WORK_DIR/helloworld/config/global_controller.yaml"
python3 -m http.server 8080 >/dev/null 2>&1 &
holder=$!
sleep 1
if ! (cd "$WORK_DIR/helloworld" && canyonos deploy </dev/null >"$ARTIFACTS_DIR/deploy-helloworld-held-8080.log" 2>&1); then
  kill "$holder"
  cat "$ARTIFACTS_DIR/deploy-helloworld-held-8080.log"
  fail "helloworld deploy with 8080 held failed"
fi
kill "$holder"
grep -q "Port 8080 is taken, so the endpoint is on" "$ARTIFACTS_DIR/deploy-helloworld-held-8080.log" ||
  fail "the deploy did not say where the endpoint moved"
[ "$(docker ps --format '{{.Names}}' | grep -c '^canyonos-dashboard-')" = 3 ] || fail "the dashboard did not come up beside the endpoint"
HELD_API="http://127.0.0.1:$(cd "$WORK_DIR/helloworld" && uv run --project "$REPO_ROOT" python -c \
  'from canyonos.gc import deployed_endpoint; from canyonos.init import load_state; print(deployed_endpoint(load_state()["port"])["api_port"])')"
python3 "$E2E_DIR/query.py" "$HELD_API" main query hello 60 >"$ARTIFACTS_DIR/helloworld-held-8080-result.json"
grep -q "greeting" "$ARTIFACTS_DIR/helloworld-held-8080-result.json" || fail "helloworld on $HELD_API returned no greeting"
(cd "$WORK_DIR/helloworld" && canyonos stop)
