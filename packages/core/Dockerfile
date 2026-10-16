# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

# Docker publishes no checksum files for its static builds, so these are pinned from the
# downloaded archives.
FROM --platform=$BUILDPLATFORM alpine:3.23.6 AS docker-cli
ARG TARGETARCH
ARG DOCKER_VERSION=29.9.0
ARG DOCKER_SHA256_AMD64=33e1ab8b63d14bca449f7a3d30d7f6aa669daa544e60a86b17fec87f61afe2b4
ARG DOCKER_SHA256_ARM64=811f6eee271678fc98dbe5c4d896c00fc5fe2daa4f7a37069c17abc036eab85b
RUN case "$TARGETARCH" in \
        amd64) arch=x86_64 sha256=$DOCKER_SHA256_AMD64 ;; \
        arm64) arch=aarch64 sha256=$DOCKER_SHA256_ARM64 ;; \
        *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && wget -qO /tmp/docker.tgz "https://download.docker.com/linux/static/stable/$arch/docker-$DOCKER_VERSION.tgz" \
    && echo "$sha256  /tmp/docker.tgz" | sha256sum -c - \
    && tar -xzf /tmp/docker.tgz -C /usr/local/bin --strip-components=1 docker/docker

# Built from source so buildx links golang.org/x/net and github.com/moby/go-archive releases
# with CVE fixes instead of the vulnerable versions v0.38.0 pins.
FROM --platform=$BUILDPLATFORM golang:1.26.9-alpine3.23 AS buildx
ARG TARGETOS
ARG TARGETARCH
ARG BUILDX_VERSION=v0.38.0
ARG BUILDX_REVISION=0dbe87f36ed472fe36b6796c3f70b4210a731fc5
ENV CGO_ENABLED=0
RUN go mod download "github.com/docker/buildx@$BUILDX_VERSION" \
    && cp -R "$(go env GOMODCACHE)/github.com/docker/buildx@$BUILDX_VERSION" /src \
    && chmod -R u+w /src
WORKDIR /src
RUN go get golang.org/x/net@v0.60.0 github.com/moby/go-archive@v0.3.0
RUN GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags "-s -w \
        -X github.com/docker/buildx/version.Version=$BUILDX_VERSION \
        -X github.com/docker/buildx/version.Revision=$BUILDX_REVISION \
        -X github.com/docker/buildx/version.Package=github.com/docker/buildx" \
        -o /out/docker-buildx ./cmd/buildx

FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends zstd openssh-client && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=buildx /out/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx

# The base image's setuptools vendors wheel and jaraco.context releases with high CVEs.
RUN pip install --no-cache-dir setuptools==84.0.0

# Installs dependencies from pyproject.toml alone so source edits don't reinstall them.
COPY pyproject.toml /src/
RUN pip install /src
COPY . /src
RUN pip install --no-deps /src

# global_controller.py bare-imports these; pip install only ships the .proto source.
RUN python -m grpc_tools.protoc \
    -I/src/canyonos_core/controller/proto \
    --python_out=/usr/local/lib/python3.11/site-packages \
    --grpc_python_out=/usr/local/lib/python3.11/site-packages \
    /src/canyonos_core/controller/proto/local_controller.proto

EXPOSE 8000

ENTRYPOINT ["python", "-m", "canyonos_core.server"]
