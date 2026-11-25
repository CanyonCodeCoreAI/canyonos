# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Registry access for the in-cluster build, by the registry's host: the CA buildx
trusts it by, when a cluster's own CA signs its certificate, and the credentials it
pushes with, for a registry that takes the build pod's own identity instead of a
docker-registry Secret. A cloud's registry (ECR, Artifact Registry, ACR) is another
entry in _REGISTRIES.

buildx reads the docker config in $HOME/.docker, which `prepare` writes: the build's
registry Secret, when it has one (the operator mounts it at $CANYONOS_REGISTRY_AUTH),
and a credential helper for a registry that takes the pod's identity and the Secret
does not name. buildx runs that helper (this module, `get`) each time it needs the
credentials, so they are read when it pushes, not when the build starts: a service
account token is replaced while a long build runs."""

import json
import logging
import os
import shutil
import sys
from dataclasses import dataclass
from fnmatch import fnmatchcase
from typing import Callable

logger = logging.getLogger(__name__)

# OpenShift's built-in registry, as the cluster's pods and nodes reach it.
OPENSHIFT_REGISTRY = "image-registry.openshift-image-registry.svc:5000"
SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount"
SYSTEM_CERTS = "/etc/ssl/certs"
# The docker config of the build's registry Secret, set by the operator.
ENV_REGISTRY_AUTH = "CANYONOS_REGISTRY_AUTH"
# docker-credential-<HELPER> is the credential helper buildx runs.
HELPER = "canyonos"


def _service_account_login():
    """The pod's service account token, which OpenShift's registry takes as the password
    for any user name; pushing needs the system:image-builder role in the namespace."""
    with open(os.path.join(SERVICE_ACCOUNT_DIR, "token"), encoding="utf-8") as f:
        return "serviceaccount", f.read().strip()


@dataclass(frozen=True)
class _Registry:
    # A pattern of the registry's host, as fnmatch reads it.
    host: str
    # The user name and password to push with; None: a Secret's, if any.
    login: Callable[[], tuple[str, str]] | None = None
    # The CA that signs the registry's certificate, besides the system's.
    ca_file: str | None = None


# The first entry whose pattern matches the registry's host applies. OpenShift's service
# CA, which OpenShift mounts beside the token, signs its registry's certificate; buildx
# asks the registry for its push token itself, so it must trust that CA too.
_REGISTRIES = (
    _Registry(
        OPENSHIFT_REGISTRY,
        login=_service_account_login,
        ca_file=os.path.join(SERVICE_ACCOUNT_DIR, "service-ca.crt"),
    ),
)


def _host(registry):
    """The host of a registry or image reference, with no scheme or path."""
    return registry.split("://", 1)[-1].split("/", 1)[0]


def _known(host):
    return next((entry for entry in _REGISTRIES if fnmatchcase(host, entry.host)), None)


def _docker_config_dir():
    return os.environ.get("DOCKER_CONFIG") or os.path.expanduser("~/.docker")


def _install_helper():
    """The docker-credential-canyonos executable, in a folder of its own; return that
    folder, for buildx's PATH."""
    helper_dir = os.path.join(os.path.expanduser("~"), ".canyonos-bin")
    os.makedirs(helper_dir, exist_ok=True)
    path = os.path.join(helper_dir, f"docker-credential-{HELPER}")
    with open(path, "w", encoding="utf-8") as f:
        f.write(f'#!/bin/sh\nexec "{sys.executable}" -m {__name__} "$@"\n')
    os.chmod(path, 0o755)
    return helper_dir


def prepare(registry):
    """Get buildx ready to push to `registry`; return the environment variables it
    needs for that. Writes its docker config from the build's registry Secret, if any,
    plus the registry's own login when it has one the Secret doesn't override, and has
    buildx trust the registry's CA, whichever credentials it pushes with."""
    host = _host(registry)
    known = _known(host)
    config_path = os.path.join(_docker_config_dir(), "config.json")
    if os.path.exists(config_path):
        # An operator before CANYONOS_REGISTRY_AUTH mounts the Secret here, read-only.
        config = None
    else:
        config = {}
        secret_path = os.environ.get(ENV_REGISTRY_AUTH)
        if secret_path:
            with open(secret_path, encoding="utf-8") as f:
                config = json.load(f)
    buildx_env = {}
    if (
        config is not None
        and known
        and known.login
        # A Secret's key may carry a scheme or path, as `kubectl create secret
        # docker-registry --docker-server=https://...` writes it.
        and host not in {_host(server) for server in config.get("auths", {})}
    ):
        config.setdefault("credHelpers", {})[host] = HELPER
        buildx_env["PATH"] = os.pathsep.join(
            [_install_helper(), os.environ.get("PATH", "")]
        )
        logger.info("Pushing to %s as this build's own identity.", host)
    if config:
        os.makedirs(os.path.dirname(config_path), exist_ok=True)
        with open(os.open(config_path, os.O_WRONLY | os.O_CREAT, 0o600), "w") as f:
            json.dump(config, f)
    if known and known.ca_file and not os.path.exists(known.ca_file):
        logger.warning(
            "%s is missing: the push to %s trusts the system's CAs only.",
            known.ca_file,
            host,
        )
    elif known and known.ca_file:
        # That CA alone, not the folder it is in, which holds the API server's CA too.
        ca_dir = os.path.join(os.path.expanduser("~"), ".canyonos-registry-ca")
        os.makedirs(ca_dir, exist_ok=True)
        shutil.copyfile(known.ca_file, os.path.join(ca_dir, "registry-ca.crt"))
        buildx_env["SSL_CERT_DIR"] = os.pathsep.join([SYSTEM_CERTS, ca_dir])
    return buildx_env


def _credential_helper(action):
    """docker's credential helper protocol, `get` only: the server on stdin, its
    credentials as JSON on stdout. Return the exit code."""
    if action != "get":
        print(f"{action} is not supported", file=sys.stderr)
        return 1
    server = sys.stdin.read().strip()
    known = _known(_host(server))
    if known is None or known.login is None:
        print("credentials not found in native keychain")
        return 1
    user, secret = known.login()
    print(json.dumps({"ServerURL": server, "Username": user, "Secret": secret}))
    return 0


if __name__ == "__main__":
    sys.exit(_credential_helper(sys.argv[1] if len(sys.argv) > 1 else ""))
