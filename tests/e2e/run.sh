#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

# Runs the README flow against a committed port, with real agents and a real LLM:
# test, deploy, status, doctor, then a query straight to the deployed REST API.
#
# Usage: tests/e2e/run.sh [fixture]          (default: portfolio)
#
# The fixture pairs examples/<fixture> (the source) with tests/e2e/<fixture>/.canyon
# (a port verified by hand), so `canyonos convert` and its coding agent stay out
# of the run. The query comes from .canyon/config/test_query.txt, and
# tests/e2e/<fixture>/check.py decides whether the result is real.
#
# Needs AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for an IAM user allowed to invoke the
# Bedrock model in us-east-1, from the environment or tests/e2e/.env.
# Logs land in $E2E_ARTIFACTS_DIR (default: a temp directory printed at the end).

set -euo pipefail

FIXTURE="${1:-portfolio}"
E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$E2E_DIR/../.." && pwd)"
SOURCE_DIR="$REPO_ROOT/examples/$FIXTURE"
CANYON_DIR="$E2E_DIR/$FIXTURE/.canyon"
CHECK="$E2E_DIR/$FIXTURE/check.py"
REQUEST_TIMEOUT=300

if [ -f "$E2E_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$E2E_DIR/.env"
  set +a
fi
: "${AWS_ACCESS_KEY_ID:?set it in the environment or in tests/e2e/.env}"
: "${AWS_SECRET_ACCESS_KEY:?set it in the environment or in tests/e2e/.env}"

# The core image is built from this checkout, here or by CI, which names it in CANYONOS_CORE_IMAGE.
export CANYONOS_ENV=development
export CANYONOS_CORE_IMAGE="${CANYONOS_CORE_IMAGE:-local}"

PROJECT_DIR="$(mktemp -d)/$FIXTURE"
ARTIFACTS_DIR="${E2E_ARTIFACTS_DIR:-$(mktemp -d)}"
STARTER_DIR=""
mkdir -p "$ARTIFACTS_DIR"

canyonos() { uv run --project "$REPO_ROOT" canyonos "$@"; }
step() { printf '\n==> %s\n' "$*"; }

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
  (cd "$PROJECT_DIR" && canyonos quit) || true
  [ -d "$STARTER_DIR" ] && (cd "$STARTER_DIR" && canyonos quit) || true
  if [ "$status" -eq 0 ]; then
    step "PASS: $FIXTURE"
  else
    step "FAIL: $FIXTURE (logs in $ARTIFACTS_DIR)"
  fi
  exit "$status"
}
trap finish EXIT

step "Staging $FIXTURE in $PROJECT_DIR"
cp -R "$SOURCE_DIR" "$PROJECT_DIR"
cp -R "$CANYON_DIR" "$PROJECT_DIR/.canyon"
cat >"$PROJECT_DIR/.env" <<EOF
AWS_ENDPOINT_URL_BEDROCK_RUNTIME=http://127.0.0.1:8081/bedrock
AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY
AWS_REGION=us-east-1
EOF
QUERY="$(cat "$PROJECT_DIR/.canyon/config/test_query.txt")"

if [ "$CANYONOS_CORE_IMAGE" = local ]; then
  step "Building canyonos-core:dev"
  docker build -q -f "$REPO_ROOT/packages/core/Dockerfile" -t canyonos-core:dev "$REPO_ROOT/packages/core"
fi

cd "$PROJECT_DIR"

# The image just built has to stop a manifest whose functions do not match the
# agent's class or cannot become a stub, whose agent takes the endpoint's name,
# or that still sets env_file, before anything is deployed.
for mode in rename builtin dunder duplicate returns deep endpoint_name env_file; do
  step "canyonos validate rejects a broken manifest ($mode)"
  broken_canyon="$(mktemp -d)/.canyon"
  cp -R "$PROJECT_DIR/.canyon" "$broken_canyon"
  expected="$(uv run --project "$REPO_ROOT" python "$E2E_DIR/break_manifest.py" "$broken_canyon" "$mode")"
  out="$ARTIFACTS_DIR/validate-$mode.json"
  canyonos validate "$broken_canyon" --json >"$out" && status=0 || status=$?
  [ "$status" -eq 1 ] && grep -qF "$expected" "$out" || { cat "$out"; exit 1; }
done

# The starter `canyonos new-app` writes has to deploy and answer as it is, with no
# LLM: `canyonos test` deploys it, queries its endpoint and reports the answer.
step "canyonos new-app writes a project that deploys and answers"
STARTER_DIR="$(mktemp -d)/starter"
mkdir "$STARTER_DIR"
out="$ARTIFACTS_DIR/new-app-test.json"
(cd "$STARTER_DIR" && canyonos new-app && canyonos test --json >"$out") || { cat "$out"; exit 1; }
grep -q '"MyAgent got: hello"' "$out" || { cat "$out"; exit 1; }

# A replica that can't launch has to fail the deploy at once, naming the agent and why.
step "canyonos test names an agent whose replica can't launch"
LAUNCH_DIR="$(mktemp -d)/starter"
cp -R "$STARTER_DIR" "$LAUNCH_DIR"
perl -0pi -e 's|(    entrypoint: agents/my_agent.py\n)|$1    resources: {cpu: 999}\n|' "$LAUNCH_DIR/config/global_controller.yaml"
out="$ARTIFACTS_DIR/new-app-unlaunchable.json"
(cd "$LAUNCH_DIR" && canyonos test --json >"$out") && { cat "$out"; exit 1; }
grep -q '"root_cause": "MyAgent could not start: ' "$out" || { cat "$out"; exit 1; }
(cd "$LAUNCH_DIR" && canyonos quit)

# A config file that is not valid YAML has to fail the deploy with one line naming it.
step "canyonos test names a config file that is not valid YAML"
printf 'models:\n  bad: [\n' >>"$STARTER_DIR/config/llms.yaml"
out="$ARTIFACTS_DIR/new-app-broken-llms.json"
(cd "$STARTER_DIR" && canyonos test --json >"$out") && { cat "$out"; exit 1; }
grep -q '"root_cause": "config/llms.yaml:[0-9]*: is not valid YAML' "$out" || { cat "$out"; exit 1; }
(cd "$STARTER_DIR" && canyonos quit)

# `canyonos test` queries a deploy that is already up instead of standing up its
# own, so start from nothing to make it deploy this fixture.
step "canyonos quit (any previous deploy)"
canyonos quit || true

step "canyonos test"
canyonos test "$QUERY" --json --timeout "$REQUEST_TIMEOUT" >"$ARTIFACTS_DIR/test.json" ||
  { cat "$ARTIFACTS_DIR/test.json"; exit 1; }
python3 -c 'import json, sys; json.dump(json.load(sys.stdin)["result"], sys.stdout)' \
  <"$ARTIFACTS_DIR/test.json" | python3 "$CHECK"

# Piped, the help screen shows every command name whole.
step "canyonos -h"
canyonos -h >"$ARTIFACTS_DIR/help.txt"
grep -q " validate " "$ARTIFACTS_DIR/help.txt" || { cat "$ARTIFACTS_DIR/help.txt"; exit 1; }

# A curl command printed whole on one line, as piped output has to keep it.
WHOLE_CURL="curl -X POST http://[^ ]+ -H \"Content-Type: application/json\" -d '\{[^}]*\}'"

# With no TTY on stdin, deploy fills in default resources where the fixture has none
# instead of opening the interactive resource picker, so a local run is unattended too.
# Piped, it still prints a line per phase.
step "canyonos deploy"
canyonos deploy --serve false </dev/null | tee "$ARTIFACTS_DIR/deploy.log"
grep -q '^Starting agents (' "$ARTIFACTS_DIR/deploy.log"
grep -qE "$WHOLE_CURL" "$ARTIFACTS_DIR/deploy.log"
ENDPOINT="$(
  uv run --project "$REPO_ROOT" python -c \
    'from canyonos.gc import deployed_endpoint; from canyonos.init import load_state; endpoint = deployed_endpoint(load_state()["port"]); print(endpoint["api_port"], endpoint["method"], endpoint["arguments"][0])'
)"
read -r API_PORT ROUTE ARGUMENT <<<"$ENDPOINT"
API_URL="http://127.0.0.1:$API_PORT"

step "canyonos status"
canyonos status | tee "$ARTIFACTS_DIR/status.log"
grep -qE "$WHOLE_CURL" "$ARTIFACTS_DIR/status.log"

# Prints "<desired> <running> <launch error>" for IntentAgent, read from `canyonos status --json`.
intent_replicas() {
  canyonos status --json >"$ARTIFACTS_DIR/status.json"
  python3 -c 'import json, sys; agent = json.load(sys.stdin)["agents"]["IntentAgent"]; print(agent["desired_replicas"], agent["running_replicas"], agent["launch_error"])' \
    <"$ARTIFACTS_DIR/status.json"
}

step "canyonos status --json"
[ "$(intent_replicas)" = "1 1 None" ] || { cat "$ARTIFACTS_DIR/status.json"; exit 1; }

# Has to return instead of following the stream.
step "canyonos logs --no-follow"
canyonos logs --no-follow >"$ARTIFACTS_DIR/logs-tail.log" 2>&1
[ -s "$ARTIFACTS_DIR/logs-tail.log" ]

# One agent's logs come from its replicas, read on their machine; an unknown name lists the agents.
step "canyonos logs IntentAgent"
canyonos logs IntentAgent --tail 20 >"$ARTIFACTS_DIR/logs-intent.log"
grep -Eqx -- "--- IntentAgent-[0-9a-f]{8} ---" "$ARTIFACTS_DIR/logs-intent.log" || { cat "$ARTIFACTS_DIR/logs-intent.log"; exit 1; }
canyonos logs NoSuchAgent >"$ARTIFACTS_DIR/logs-unknown.log" 2>&1 && { cat "$ARTIFACTS_DIR/logs-unknown.log"; exit 1; }
grep -q "the agents are .*IntentAgent" "$ARTIFACTS_DIR/logs-unknown.log" || { cat "$ARTIFACTS_DIR/logs-unknown.log"; exit 1; }

# Run after the deploy, so doctor checks the live stack.
step "canyonos doctor"
canyonos doctor

step "Query $API_URL/$ROUTE"
python3 "$E2E_DIR/query.py" "$API_URL" "$ROUTE" "$ARGUMENT" "$QUERY" "$REQUEST_TIMEOUT" \
  >"$ARTIFACTS_DIR/deploy-result.json" 2> >(tee "$ARTIFACTS_DIR/deploy-query.log" >&2)
python3 "$CHECK" <"$ARTIFACTS_DIR/deploy-result.json"

# Cleanup expires a finished request's keys 30s after delivery; /status must still answer.
step "Status of the request after cleanup"
sleep 60
request_id="$(sed -n 's/.*-> request //p' "$ARTIFACTS_DIR/deploy-query.log")"
curl -fsS "$API_URL/status/$request_id" | grep -q '"status":"done"'

# A 16-hex-character argument is a plain string, not a Future id. Before CAN-452
# the workflow's own request waited 300s for `future:deadbeefdeadbeef` and timed
# out, so the request has to reach done or error quickly and nothing may wait on
# a Future: the portfolio workflow never passes one as an argument.
step "Query $API_URL/$ROUTE with a 16-hex-character string"
python3 "$E2E_DIR/query.py" "$API_URL" "$ROUTE" "$ARGUMENT" deadbeefdeadbeef 60 \
  >"$ARTIFACTS_DIR/hex-result.json" 2>"$ARTIFACTS_DIR/hex-query.log" || true
cat "$ARTIFACTS_DIR/hex-query.log"
if grep -q "did not finish" "$ARTIFACTS_DIR/hex-query.log"; then exit 1; fi
workflow="$(docker ps --filter name=-workflow- --format '{{.Names}}' | head -n 1)"
if docker logs "$workflow" 2>&1 | grep -E "waiting for result|waiting for argument"; then
  echo "the workflow treated the 16-hex-character argument as a Future"
  exit 1
fi

# A called agent's failure must reach the caller as that agent's own error, not a bare type name.
step "Query $API_URL/$ROUTE with a request that has no holdings"
python3 "$E2E_DIR/query.py" "$API_URL" "$ROUTE" "$ARGUMENT" "I own no stocks" 120 \
  >/dev/null 2>"$ARTIFACTS_DIR/error-query.log" || true
cat "$ARTIFACTS_DIR/error-query.log"
if ! grep -q "workflow error: IntentAgent.parse failed: " "$ARTIFACTS_DIR/error-query.log"; then
  echo "the error does not name the agent that failed"
  exit 1
fi

# A body missing the endpoint's argument has to be refused before anything runs.
step "POST $API_URL/$ROUTE without $ARGUMENT"
code="$(curl -s -o "$ARTIFACTS_DIR/missing-argument.json" -w '%{http_code}' \
  -X POST "$API_URL/$ROUTE" -H 'Content-Type: application/json' -d '{}')"
cat "$ARTIFACTS_DIR/missing-argument.json"
[ "$code" = 400 ] || { echo "expected a 400, got $code"; exit 1; }

# After the queries, since it kills a gateway: LLM calls, streams, child processes, passthrough, prices and restart, from inside a replica.
step "LLM gateway and proxy inside an agent replica"
agent="$(docker ps --filter name=-priceagent- --format '{{.Names}}' | head -n 1)"
docker cp "$E2E_DIR/gateway_check.py" "$agent:/tmp/gateway_check.py"
docker exec "$agent" python /tmp/gateway_check.py | tee "$ARTIFACTS_DIR/gateway-check.log"

# A config change has to reach the running deploy through `canyonos sync`, with no redeploy.
step "canyonos sync scales IntentAgent to 2"
perl -0pi -e 's|(name: IntentAgent\n.*\n    replicas: )1|${1}2|' "$PROJECT_DIR/.canyon/config/global_controller.yaml"
canyonos sync
for _ in $(seq 30); do [ "$(intent_replicas)" = "2 2 None" ] && break; sleep 2; done
[ "$(intent_replicas)" = "2 2 None" ] || { cat "$ARTIFACTS_DIR/status.json"; exit 1; }

# `canyonos test` queries the running deploy only while it holds the project's current files.
step "canyonos test queries the running deploy after a sync"
out="$ARTIFACTS_DIR/test-existing.json"
canyonos test "$QUERY" --json --timeout "$REQUEST_TIMEOUT" >"$out" || { cat "$out"; exit 1; }
grep -q '"against_existing_deploy": true' "$out" || { cat "$out"; exit 1; }

step "canyonos test refuses a running deploy older than the config or the code"
echo "# edited" >>"$PROJECT_DIR/.canyon/config/global_controller.yaml"
out="$ARTIFACTS_DIR/test-stale-config.json"
canyonos test --json >"$out" && { cat "$out"; exit 1; }
grep -q 'Files in config/ changed' "$out" || { cat "$out"; exit 1; }
echo "# edited" >>"$PROJECT_DIR/.canyon/agents/risk_agent.py"
out="$ARTIFACTS_DIR/test-stale-code.json"
canyonos test --json >"$out" && { cat "$out"; exit 1; }
grep -q 'Files outside config/ changed' "$out" || { cat "$out"; exit 1; }

step "canyonos stop, then canyonos status exits 1"
canyonos stop
# Nothing is left to stop, which is still a success.
canyonos stop
canyonos status --json >"$ARTIFACTS_DIR/stopped-status.json" && { cat "$ARTIFACTS_DIR/stopped-status.json"; exit 1; }
grep -q '"running": false' "$ARTIFACTS_DIR/stopped-status.json" || { cat "$ARTIFACTS_DIR/stopped-status.json"; exit 1; }
