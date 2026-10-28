#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

# Deploys tests/e2e/ec2_pool onto a pool of EC2 machines (2 t3.micro, 1 t3.small) and
# checks the pool end to end: the provider and machine_type config rules, every machine
# starting at deploy, least-loaded placement with memory counted, CPU-share prices, a
# call lost with its machine failing fast, the dead machine replaced and its replicas
# relaunched, a reload that drops a machine, scale-ups, a full pool shared instead of
# refused, and `canyonos quit` terminating every machine.
#
# Needs AWS access allowed to run EC2, either this machine's own role or
# AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, and EC2_REGION, EC2_SUBNET_ID and
# EC2_SECURITY_GROUP_ID for a subnet this machine reaches by private IP, from the
# environment or tests/e2e/.env. Starts 4 machines for about 15 minutes.
# Logs land in $E2E_ARTIFACTS_DIR (default: a temp directory printed at the end).
#
# Usage: tests/e2e/ec2_pool.sh

set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$E2E_DIR/../.." && pwd)"
FIXTURE_DIR="$E2E_DIR/ec2_pool"

if [ -f "$E2E_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$E2E_DIR/.env"
  set +a
fi
: "${EC2_REGION:?set it in the environment or in tests/e2e/.env}"
: "${EC2_SUBNET_ID:?set it in the environment or in tests/e2e/.env}"
: "${EC2_SECURITY_GROUP_ID:?set it in the environment or in tests/e2e/.env}"
export EC2_REGION EC2_SUBNET_ID EC2_SECURITY_GROUP_ID

# The core image is built from this checkout, so the run tests the code under review.
export CANYONOS_ENV=development
export CANYONOS_CORE_IMAGE=local
ARTIFACTS_DIR="${E2E_ARTIFACTS_DIR:-$(mktemp -d)}"
mkdir -p "$ARTIFACTS_DIR"
PROJECT_DIR="$(mktemp -d)/ec2pool"
START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

step() { printf '\n==> %s\n' "$*"; }
pool() { uv run --project "$REPO_ROOT" python "$FIXTURE_DIR/pool.py" "$@"; }

finish() {
  status=$?
  step "Collecting container logs into $ARTIFACTS_DIR"
  for name in $(docker ps -a --filter name=canyonos --format '{{.Names}}'); do
    docker logs "$name" >"$ARTIFACTS_DIR/$name.log" 2>&1 || true
  done
  (cd "$PROJECT_DIR" && canyonos quit) || true
  if [ "$status" -eq 0 ]; then
    step "PASS: ec2_pool"
  else
    # Whatever this run started must not keep billing.
    pool instances "$START" any shutting-down terminated ||
      step "Some machines this run launched are still running: terminate them in $EC2_REGION"
    step "FAIL: ec2_pool (logs in $ARTIFACTS_DIR)"
  fi
  exit "$status"
}
trap finish EXIT

step "Staging the pool app in $PROJECT_DIR"
cp -R "$FIXTURE_DIR" "$PROJECT_DIR"
rm "$PROJECT_DIR/pool.py"
# The controller reads the ec2: block's ${EC2_*} values, and keys when given, from the
# app's .env; without keys it uses this machine's role.
printf 'EC2_REGION=%s\nEC2_SUBNET_ID=%s\nEC2_SECURITY_GROUP_ID=%s\nEC2_POOL_SMALL_TYPE=t3.small\n' \
  "$EC2_REGION" "$EC2_SUBNET_ID" "$EC2_SECURITY_GROUP_ID" >"$PROJECT_DIR/.env"
chmod 600 "$PROJECT_DIR/.env"
if [ -n "${AWS_ACCESS_KEY_ID:-}" ]; then
  printf 'AWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s\n' \
    "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" >>"$PROJECT_DIR/.env"
fi

step "Building canyonos-core:dev"
docker build -q -f "$REPO_ROOT/packages/core/Dockerfile" -t canyonos-core:dev "$REPO_ROOT/packages/core" >/dev/null

# The deployment picks one provider, agents cannot pick their own, and machine_type maps
# each type to how many machines of it to start.
while IFS='|' read -r case expected; do
  step "canyonos validate: $case"
  # validate checks a project root: its code and its manifest in config/.
  copy="$(mktemp -d)/project"
  cp -R "$PROJECT_DIR" "$copy"
  uv run --project "$REPO_ROOT" python - "$copy/config/global_controller.yaml" "$case" <<'PY'
import sys, yaml
path, case = sys.argv[1:]
config = yaml.safe_load(open(path))
# Literal values, since the image validate runs in has no EC2_* variables.
config["ec2"].update(region="us-east-1", subnet_id="subnet-0", security_group_ids=["sg-0"])
if case == "an agent sets provider":
    config["agents"][0]["provider"] = "EC2"
elif case == "an agent sets machine_type":
    config["agents"][0]["machine_type"] = "t3.micro"
elif case == "an unknown provider":
    config["provider"] = "aws"
elif case == "EC2 without an ec2 block":
    del config["ec2"]
elif case == "machine_type as one type":
    config["ec2"]["machine_type"] = "t3.micro"
elif case == "machine_type with a count of 0":
    config["ec2"]["machine_type"] = {"t3.micro": 0}
elif case == "provider in lowercase":
    config["provider"] = "ec2"
elif case == "provider left out":
    del config["provider"]
elif case == "an ec2 block without machine_type":
    del config["ec2"]["machine_type"]
yaml.safe_dump(config, open(path, "w"), sort_keys=False)
PY
  out="$ARTIFACTS_DIR/validate-${case// /-}.json"
  canyonos validate "$copy" --json >"$out" </dev/null && status=0 || status=$?
  if [ -z "$expected" ]; then
    [ "$status" -eq 0 ] || { cat "$out"; exit 1; }
  else
    [ "$status" -eq 1 ] && grep -qF "$expected" "$out" || { cat "$out"; exit 1; }
  fi
done <<'CASES'
an agent sets provider|unknown key 'provider'
an agent sets machine_type|unknown key 'machine_type'
an unknown provider|expected one of ['local', 'EC2']
EC2 without an ec2 block|is required because provider is 'EC2'
machine_type as one type|expected a mapping of names to counts
machine_type with a count of 0|expected an integer >= 1
an ec2 block without machine_type|ec2.machine_type
provider in lowercase|
provider left out|
CASES

cd "$PROJECT_DIR"
canyonos quit || true

step "canyonos deploy starts every machine of the pool"
canyonos deploy --serve false </dev/null
pool check-pool
pool instances "$START" 3 running

step "Placement: least loaded, memory counted, priced by CPU share"
pool check-placement

step "A call lost with its machine fails fast, and the machine is replaced"
request="$(pool call 600)"
# Long enough for SlowAgent to be running the call.
sleep 15
dead="$(pool kill SlowAgent-0)"
pool status "$request" 180 error
pool replaced "$dead" 600
pool instances "$START" 4 running shutting-down terminated
pool status "$(pool call 1)" 120 done

step "A reload with one t3.micro fewer terminates the newest and keeps every replica"
pool shrink t3.micro 600

step "A scale-up goes to the least loaded machine"
pool scale-up Small 2 300

step "A full pool is shared instead of refusing replicas"
pool oversubscribe SlowAgent 6 600

step "canyonos quit terminates every machine, even with one just gone"
pool kill Big-0 >/dev/null
canyonos quit
sleep 30
# A pass between the kill and the quit may have started a replacement.
pool instances "$START" any shutting-down terminated
left="$(docker ps -aq --filter name=canyonos)"
[ -z "$left" ] || { docker ps -a --filter name=canyonos; exit 1; }
