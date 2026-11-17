# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

# The base every agent image starts from: the agent's Python plus the LLM gateway's own venv.
# Agent images name it by a hash of this file; .github/workflows/agent-base.yml publishes each one.
ARG PYTHON_VERSION
FROM python:${PYTHON_VERSION}-slim

# Under /opt, not /root, so an agent run as another user (Kubernetes' restricted profile, OpenShift) can start the gateway.
ENV UV_COMPILE_BYTECODE=1 UV_PYTHON_INSTALL_DIR=/opt/canyonos-python

# The gateway runs from its own Python 3.12 venv (mitmproxy 12 needs it), so these exact pins never meet the app's.
RUN --mount=type=cache,target=/root/.cache/uv --mount=from=ghcr.io/astral-sh/uv:latest,source=/uv,target=/bin/uv uv venv --python 3.12 /opt/canyonos-gateway \
 && uv pip install --python /opt/canyonos-gateway/bin/python flask==3.1.3 requests==2.34.2 redis==8.1.0 mitmproxy==12.2.3
