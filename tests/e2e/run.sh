#!/usr/bin/env bash
# Runs the README flow against a committed port, with real agents and a real LLM:
# test, deploy, status, doctor, then a query straight to the deployed REST API.
#
# Usage: tests/e2e/run.sh [fixture]          (default: portfolio)
#
# The fixture pairs examples/<fixture> (the source) with tests/e2e/<fixture>/.car
# (a port verified by hand), so `canyonos build` and its coding agent stay out
# of the run. The query comes from .car/config/test_query.txt, and
# tests/e2e/<fixture>/check.py decides whether the result is real.
#
# Needs AWS_BEARER_TOKEN_BEDROCK (us-east-1), from the environment or tests/e2e/.env.
# Logs land in $E2E_ARTIFACTS_DIR (default: a temp directory printed at the end).

set -euo pipefail

FIXTURE="${1:-portfolio}"
E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$E2E_DIR/../.." && pwd)"
SOURCE_DIR="$REPO_ROOT/examples/$FIXTURE"
CAR_DIR="$E2E_DIR/$FIXTURE/.car"
CHECK="$E2E_DIR/$FIXTURE/check.py"
REQUEST_TIMEOUT=300

if [ -f "$E2E_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$E2E_DIR/.env"
  set +a
fi
: "${AWS_BEARER_TOKEN_BEDROCK:?set it in the environment or in tests/e2e/.env}"

# The core image is built from this checkout, so the run tests the code under review.
export CANYONOS_ENV=development
export CANYONOS_CORE_IMAGE=local

PROJECT_DIR="$(mktemp -d)/$FIXTURE"
ARTIFACTS_DIR="${E2E_ARTIFACTS_DIR:-$(mktemp -d)}"
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
cp -R "$CAR_DIR" "$PROJECT_DIR/.car"
cat >"$PROJECT_DIR/.env" <<EOF
AWS_ENDPOINT_URL_BEDROCK_RUNTIME=http://127.0.0.1:8081/bedrock
AWS_BEARER_TOKEN_BEDROCK=$AWS_BEARER_TOKEN_BEDROCK
AWS_REGION=us-east-1
EOF
QUERY="$(cat "$PROJECT_DIR/.car/config/test_query.txt")"
API_URL="http://127.0.0.1:$(
  cd "$PROJECT_DIR" &&
    uv run --project "$REPO_ROOT" python -c \
      'from canyonos.constants import default_config_path, workflow_api_port; print(workflow_api_port(default_config_path()))'
)"

step "Building canyonos-core:dev"
docker build -q -f "$REPO_ROOT/packages/core/Dockerfile" -t canyonos-core:dev "$REPO_ROOT/packages/core"

cd "$PROJECT_DIR"

# `canyonos test` queries a deploy that is already up instead of standing up its
# own, so start from nothing to make it deploy this fixture.
step "canyonos quit (any previous deploy)"
canyonos quit || true

step "canyonos test --real-llm"
canyonos test "$QUERY" --real-llm --json --timeout "$REQUEST_TIMEOUT" >"$ARTIFACTS_DIR/test.json" ||
  { cat "$ARTIFACTS_DIR/test.json"; exit 1; }
python3 -c 'import json, sys; json.dump(json.load(sys.stdin)["result"], sys.stdout)' \
  <"$ARTIFACTS_DIR/test.json" | python3 "$CHECK"

step "canyonos deploy"
canyonos deploy --serve false

step "canyonos status"
canyonos status

# After a deploy, doctor checks the live stack (controller, Redis, agents); before
# one it would demand a coding agent, which this flow deliberately skips.
step "canyonos doctor"
canyonos doctor

step "Query $API_URL"
python3 "$E2E_DIR/query.py" "$API_URL" "$QUERY" "$REQUEST_TIMEOUT" >"$ARTIFACTS_DIR/deploy-result.json"
python3 "$CHECK" <"$ARTIFACTS_DIR/deploy-result.json"
