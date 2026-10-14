#!/bin/bash

# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

set -e

echo "==========================================="
echo "   CanyonOS Integration & Performance Tests"
echo "==========================================="

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"

echo ">> 0. Running small pytest suite..."
python3 -m pytest "$SCRIPT_DIR" "$SCRIPT_DIR/../packages"

TEST_DIR="/tmp/canyonos_test_env_$$"
PROJECT_NAME="canyonos_test"
# The helloworld example's Redis port, which the dashboard keeps for this project.
REDIS_PORT=6380

# Each copy below is its own CanyonOS project, so each one is quit from its folder.
function cleanup {
    echo ">> Cleaning up test environment..."
    for project in "$TEST_DIR/$PROJECT_NAME" "$TEST_DIR/context_propagation"; do
        if [ -d "$project" ]; then
            (cd "$project" && canyonos quit) || true
        fi
    done
    rm -rf "$TEST_DIR"
    echo ">> Cleanup complete."
}
trap cleanup EXIT

mkdir -p "$TEST_DIR"
cd "$TEST_DIR"

echo ">> 1. Copying the helloworld example..."
cp -R "$SCRIPT_DIR/../examples/helloworld" $PROJECT_NAME
cd $PROJECT_NAME

echo ">> 2. Building and deploying the project (canyonos deploy)..."
canyonos deploy </dev/null
echo ">> Deployment healthy! Checking the dashboard registers this project..."
until curl -sf -X POST http://127.0.0.1:3000/canyonos/projects -H "Content-Type: application/json" -d "{\"redis_port\": $REDIS_PORT}" | grep -q '"project_id"'; do sleep 2; done
echo ">> Running test suite."

ORIG_CWD=$(pwd)

echo "-------------------------------------------"
echo ">> Running Integration Tests..."
python3 "$SCRIPT_DIR/test_integration.py" || exit 1

echo "-------------------------------------------"
echo ">> Running Performance/Load Tests..."
python3 "$SCRIPT_DIR/test_performance.py" --concurrent 5 --total 20 || exit 1

echo "-------------------------------------------"
echo ">> Redeploying with the context propagation workflow..."
# A separate project folder gets its own Global Controller, so quit this one
# instead of stopping it: both publish the endpoint on the same port.
canyonos quit
cd "$TEST_DIR"
cp -R "$SCRIPT_DIR/../examples/helloworld" context_propagation
cp "$SCRIPT_DIR/context_propagation_workflow.py" context_propagation/agents/workflow.py
cd context_propagation
canyonos deploy --serve false </dev/null

echo ">> Running Context Propagation Tests..."
python3 "$SCRIPT_DIR/test_context_propagation.py" || exit 1

echo "==========================================="
echo "   All Tests Passed Successfully!"
echo "==========================================="
