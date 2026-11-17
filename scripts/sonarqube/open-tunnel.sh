#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

set -euo pipefail

: "${SONARQUBE_MACHINE_ID:?Set SONARQUBE_MACHINE_ID to the EC2 machine ID.}"

if ! command -v session-manager-plugin >/dev/null; then
  echo 'Install the AWS Session Manager plugin before opening the tunnel.' >&2
  exit 1
fi

aws ssm start-session \
  --target "$SONARQUBE_MACHINE_ID" \
  --document-name AWS-StartPortForwardingSession \
  --parameters portNumber=9000,localPortNumber=9000
