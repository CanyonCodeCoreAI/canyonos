#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

# Runs the governance rules against examples/pr_review, with real agents and a
# real Bedrock call: a required agent going down refuses its dependents (an
# inner call, then the endpoint's root call with a 403), spend over a threshold
# switches ReviewAgent's model and then refuses it, a config reload keeps the
# rules edited in Redis, and a crash-looping replica counts as down.
#
# Usage: tests/e2e/governance.sh
#
# Rules and spend are written straight to the controller's Redis, as the
# dashboard API does. Needs AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for an
# IAM user allowed to invoke both Bedrock models in us-east-1, from the
# environment or tests/e2e/.env. BEDROCK_SWITCH_MODEL_ID names the model the
# spend rule switches to. Logs land in $E2E_ARTIFACTS_DIR (default: a temp
# directory printed at the end).

set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$E2E_DIR/../.." && pwd)"
SOURCE_DIR="$REPO_ROOT/examples/pr_review"
CANYON_DIR="$E2E_DIR/pr_review/.canyon"
CHECK="$E2E_DIR/pr_review/check.py"
REQUEST="$E2E_DIR/pr_review/request.py"
REQUEST_TIMEOUT=300
# One Local Controller poll plus a margin: how long a Redis edit takes to reach every replica.
RULES_REFRESH=6

if [ -f "$E2E_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$E2E_DIR/.env"
  set +a
fi
: "${AWS_ACCESS_KEY_ID:?set it in the environment or in tests/e2e/.env}"
: "${AWS_SECRET_ACCESS_KEY:?set it in the environment or in tests/e2e/.env}"
BEDROCK_SWITCH_MODEL_ID="${BEDROCK_SWITCH_MODEL_ID:-meta.llama3-8b-instruct-v1:0}"

# The core image is built from this checkout, here or by CI, which names it in CANYONOS_CORE_IMAGE.
export CANYONOS_ENV=development
export CANYONOS_CORE_IMAGE="${CANYONOS_CORE_IMAGE:-local}"

# A fresh copy gets its own project_id at deploy, so the project, and every
# `canyonos stop` here, is never a developer's own deploy of examples/pr_review.
PROJECT_DIR="$(mktemp -d)/pr_review_e2e"
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
  (cd "$PROJECT_DIR" && canyonos stop) || true
  if [ "$status" -eq 0 ]; then
    step "PASS: governance"
  else
    step "FAIL: governance (logs in $ARTIFACTS_DIR)"
  fi
  exit "$status"
}
trap finish EXIT

# The controller's Redis, through its container, so no redis-cli is needed on this machine.
redis() { docker exec "$REDIS_CONTAINER" redis-cli -p "$REDIS_PORT" "$@"; }

# Waits up to $1 seconds for the command after it to succeed.
wait_until() {
  local deadline=$((SECONDS + $1))
  shift
  until "$@"; do
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 2
  done
}

# TestRunnerAgent's replica addresses in the routing table, failing the run when Redis can't say.
test_runner_routes() {
  local routes
  routes="$(redis HGET routing_table:replicas TestRunnerAgent)" || fail "could not read routing_table:replicas"
  [ -n "$routes" ] || fail "routing_table:replicas has no TestRunnerAgent entry"
  echo "$routes"
}

# A failure inside $(...) only ends that subshell, hence the `|| exit 1`.
test_runner_unrouted() {
  local routes
  routes="$(test_runner_routes)" || exit 1
  [ "$routes" = "[]" ]
}

# A replica record exists while the container still boots; the reconciler puts the
# agent in routing_table:up, which governance reads, once a replica reports healthy
# with a fresh heartbeat.
test_runner_up() {
  [ "$(redis SISMEMBER routing_table:up TestRunnerAgent)" = 1 ]
}

# Sends the test query to POST /review and waits for it; $1 names its artifacts.
# Sets REQUEST_ID, STATUS and ERROR from the request's final /status.
send_query() {
  local out="$ARTIFACTS_DIR/$1.json"
  python3 "$REQUEST" "$API_URL/review" "$QUERY" "$REQUEST_TIMEOUT" >"$out" 2>"$ARTIFACTS_DIR/$1.log" ||
    { cat "$ARTIFACTS_DIR/$1.log"; fail "the request did not finish"; }
  cat "$out"
  REQUEST_ID="$(python3 -c 'import json, sys; print(json.load(sys.stdin)["request_id"])' <"$out")"
  STATUS="$(python3 -c 'import json, sys; print(json.load(sys.stdin)["status"])' <"$out")"
  ERROR="$(python3 -c 'import json, sys; print(json.load(sys.stdin).get("error") or "")' <"$out")"
}

expect_error() {
  [ "$STATUS" = error ] || fail "request $REQUEST_ID ended $STATUS, expected an error naming $1"
  case "$ERROR" in *"$1"*) ;; *) fail "request $REQUEST_ID failed without naming $1: $ERROR" ;; esac
}

expect_done() {
  [ "$STATUS" = done ] || fail "request $REQUEST_ID ended $STATUS: $ERROR"
  python3 -c 'import json, sys; json.dump(json.load(sys.stdin)["result"], sys.stdout)' \
    <"$ARTIFACTS_DIR/$1.json" | python3 "$CHECK"
}

# Prints the id of the future request $1 made for $2.$3 ($2 alone for the root call).
future_of() {
  local id
  for id in $(redis SMEMBERS "request:$1:futures"); do
    [ "$(redis HGET "future:$id" service)" = "$2" ] || continue
    if [ -n "${3:-}" ]; then
      [ "$(redis HGET "future:$id" method)" = "$3" ] && { echo "$id"; return; }
    elif [ -z "$(redis HGET "future:$id" parent)" ]; then
      echo "$id"
      return
    fi
  done
  fail "request $1 has no future for $2${3:+.$3}"
}

expect_error_name() {
  local future
  future="$(future_of "$REQUEST_ID" "$1" "${2:-}")"
  [ "$(redis HGET "future:$future" error_name)" = "$3" ] ||
    fail "$1${2:+.$2} has error_name '$(redis HGET "future:$future" error_name)', expected '$3'"
}

# Prints governance:config with $1, a Python statement on `agents`, applied.
edited_config() {
  python3 -c 'import json, sys; config = json.loads(sys.argv[1]); agents = config["agents"]; exec(sys.argv[2]); print(json.dumps(config))' \
    "$GOVERNANCE_SEED" "$1"
}

# Has the running deploy reload the project as it is on disk, the way a config edit reaches it.
reload() {
  (cd "$PROJECT_DIR" && uv run --project "$REPO_ROOT" python -c \
    'from canyonos.gc import post_reload; from canyonos.init import load_state; from canyonos.sync import run_sync; assert run_sync(); post_reload(load_state()["port"])')
  sleep $((RULES_REFRESH * 2))
}

step "Staging pr_review in $PROJECT_DIR"
cp -R "$SOURCE_DIR" "$PROJECT_DIR"
# A developer's own .canyon, project_id included, must not come along.
rm -rf "$PROJECT_DIR/.canyon"
cp -R "$CANYON_DIR" "$PROJECT_DIR/.canyon"
cat >"$PROJECT_DIR/.env" <<EOF
AWS_ENDPOINT_URL_BEDROCK_RUNTIME=http://127.0.0.1:8081/bedrock
AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY
AWS_REGION=us-east-1
BEDROCK_SWITCH_MODEL_ID=$BEDROCK_SWITCH_MODEL_ID
EOF
QUERY="$(cat "$PROJECT_DIR/.canyon/config/test_query.txt")"

if [ "$CANYONOS_CORE_IMAGE" = local ]; then
  step "Building canyonos-core:dev"
  docker build -q -f "$REPO_ROOT/packages/core/Dockerfile" -t canyonos-core:dev "$REPO_ROOT/packages/core"
fi

cd "$PROJECT_DIR"

# Deployed first, so `canyonos test` queries it and leaves it up for the steps below.
step "1. Deploy, then canyonos test answers with a review"
canyonos stop || true
canyonos deploy --serve false </dev/null >"$ARTIFACTS_DIR/deploy.log" 2>&1 ||
  { cat "$ARTIFACTS_DIR/deploy.log"; fail "the deploy failed"; }
# Two polls: the reconciler's pass that counts each replica up, then every controller's
# snapshot that reads it.
sleep $((RULES_REFRESH * 2))
canyonos test "$QUERY" --json --timeout "$REQUEST_TIMEOUT" >"$ARTIFACTS_DIR/test.json" ||
  { cat "$ARTIFACTS_DIR/test.json"; fail "canyonos test failed"; }
python3 -c 'import json, sys; json.dump(json.load(sys.stdin)["result"], sys.stdout)' \
  <"$ARTIFACTS_DIR/test.json" | python3 "$CHECK"
API_PORT="$(
  uv run --project "$REPO_ROOT" python -c \
    'from canyonos.gc import deployed_endpoint; from canyonos.init import load_state; print(deployed_endpoint(load_state()["port"])["api_port"])'
)"
API_URL="http://127.0.0.1:$API_PORT"
# Read after the deploy, which writes the project_id the container name ends with.
read -r REDIS_CONTAINER REDIS_PORT <<<"$(uv run --project "$REPO_ROOT" python -c \
  'from canyonos.constants import default_config_path, local_redis_port; from canyonos.project import project_name; print(f"canyonos-{project_name()}-redis-localhost", local_redis_port(default_config_path()))')"

step "2. The deploy seeds governance:config from governance.yaml"
GOVERNANCE_SEED="$(redis GET governance:config)"
echo "$GOVERNANCE_SEED"
python3 -c '
import json, sys
agents = json.loads(sys.argv[1] or "{}").get("agents", {})
if agents.get("MergeAgent", {}).get("requires") != ["TestRunnerAgent"]:
    sys.exit("MergeAgent does not require TestRunnerAgent")
if not agents.get("ReviewAgent", {}).get("spend", {}).get("since"):
    sys.exit("ReviewAgent has no spend.since stamped at deploy")
' "$GOVERNANCE_SEED" || fail "governance:config is not the seeded governance.yaml"

step "3. With TestRunnerAgent stopped, MergeAgent.merge is refused with DependencyDown"
redis SET agent:TestRunnerAgent:desired_replicas 0
wait_until 60 test_runner_unrouted || fail "TestRunnerAgent still has a replica after 60s"
sleep "$RULES_REFRESH"
send_query dependency-down
expect_error DependencyDown
expect_error_name Workflow "" ""
expect_error_name MergeAgent merge DependencyDown

step "4. A root call whose own requirement is down gets a 403"
redis SET governance:config "$(edited_config 'agents["Workflow"] = {"requires": ["TestRunnerAgent"]}')"
sleep "$RULES_REFRESH"
code="$(curl -s -o "$ARTIFACTS_DIR/root-refused.json" -w '%{http_code}' \
  -X POST "$API_URL/review" -H 'Content-Type: application/json' -d "$QUERY")"
cat "$ARTIFACTS_DIR/root-refused.json"
[ "$code" = 403 ] || fail "expected a 403, got $code"
grep -q '"error_name": *"DependencyDown"' "$ARTIFACTS_DIR/root-refused.json" ||
  fail "the 403 body does not name DependencyDown"

step "5. With TestRunnerAgent back and the seed restored, the query succeeds again"
redis SET agent:TestRunnerAgent:desired_replicas 1
redis SET governance:config "$GOVERNANCE_SEED"
wait_until 120 test_runner_up || fail "TestRunnerAgent is not up after 120s"
sleep "$RULES_REFRESH"
send_query restored
expect_done restored

step "6. Spend above the switch threshold moves ReviewAgent to $BEDROCK_SWITCH_MODEL_ID"
redis SET governance:spend '{"ReviewAgent": 6}'
sleep "$RULES_REFRESH"
send_query switched
expect_done switched
review_future="$(future_of "$REQUEST_ID" ReviewAgent review)"
model="$(redis HGET "future:$review_future" model)"
[ "$model" = "$BEDROCK_SWITCH_MODEL_ID" ] || fail "ReviewAgent called '$model', expected '$BEDROCK_SWITCH_MODEL_ID'"

step "7. Spend above a deny threshold refuses ReviewAgent.review with SpendLimit"
redis SET governance:config "$(edited_config 'agents["ReviewAgent"]["spend"]["rules"].append({"above_usd": 7, "action": {"kind": "deny"}})')"
redis SET governance:spend '{"ReviewAgent": 8}'
sleep "$RULES_REFRESH"
send_query denied
expect_error SpendLimit
expect_error_name ReviewAgent review SpendLimit

step "8. A config reload keeps the rules edited in Redis"
reload
python3 -c '
import json, sys
rules = json.loads(sys.argv[1] or "{}")["agents"]["ReviewAgent"]["spend"]["rules"]
if not any(rule["action"]["kind"] == "deny" for rule in rules):
    sys.exit("the deny rule is gone")
' "$(redis GET governance:config)" || fail "the reload replaced the edited governance:config"

# TestRunnerAgent's replica is removed first, so the one the reload brings back
# (it restores the configured count) reads the new .env and crashes at every start.
step "9. A crash-looping TestRunnerAgent counts as down"
redis SET governance:config "$GOVERNANCE_SEED"
redis SET governance:spend '{}'
redis SET agent:TestRunnerAgent:desired_replicas 0
wait_until 60 test_runner_unrouted || fail "TestRunnerAgent still has a replica after 60s"
echo "TESTRUNNER_BROKEN=1" >>"$PROJECT_DIR/.env"
reload
sleep 60
# Still routed: the agent is down by its health, not because it has no replica as in step 3.
routes="$(test_runner_routes)" || exit 1
case "$routes" in
  *testrunneragent*) ;;
  *) fail "the crash-looping TestRunnerAgent replica left the routing table" ;;
esac
[ "$(redis GET agent:TestRunnerAgent:desired_replicas)" = 1 ] || fail "TestRunnerAgent is no longer desired"
send_query crash-loop
expect_error DependencyDown
expect_error_name MergeAgent merge DependencyDown
