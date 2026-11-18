# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""This container's certificate for the deployment's internal traffic.

On Docker, the Global Controller gives every container it starts the deployment CA's
certificate and a certificate of the container's own, signed by that CA, in the
variables below (base64 of the PEM). With them, Redis and the gRPC calls between
controllers use mutual TLS; without them (EC2, Kubernetes) both stay plaintext.

Stdlib only: the LLM gateway's own venv and agent images import it flat, as
`canyonos_internal_tls`, and they have no `cryptography`.
"""

import base64
import os
import tempfile
import threading

CA_CERT_ENV = "CANYONOS_TLS_CA_CERT"
CERT_ENV = "CANYONOS_TLS_CERT"
KEY_ENV = "CANYONOS_TLS_KEY"
CREDENTIAL_ENVS = (CA_CERT_ENV, CERT_ENV, KEY_ENV)

# The Redis client options `connection_options` reads; `export_files` sets them, so the
# agent's own Redis clients can use them too.
REDIS_TLS_ENV = "CANYONOS_REDIS_TLS"
REDIS_CA_FILE_ENV = "CANYONOS_REDIS_CA_FILE"
REDIS_CERT_FILE_ENV = "CANYONOS_REDIS_CERT_FILE"
REDIS_KEY_FILE_ENV = "CANYONOS_REDIS_KEY_FILE"
_FILES = (
    (CA_CERT_ENV, "ca.crt", REDIS_CA_FILE_ENV),
    (CERT_ENV, "tls.crt", REDIS_CERT_FILE_ENV),
    (KEY_ENV, "tls.key", REDIS_KEY_FILE_ENV),
)

_export_lock = threading.Lock()


def enabled(environ=None):
    """True when this container was given its certificate, so internal traffic is TLS."""
    env = os.environ if environ is None else environ
    return all(env.get(name) for name in CREDENTIAL_ENVS)


def credentials(environ=None):
    """The CA certificate, this container's certificate and its key, as PEM bytes."""
    env = os.environ if environ is None else environ
    ca, cert, key = (base64.b64decode(env[name]) for name in CREDENTIAL_ENVS)
    return ca, cert, key


def export_files():
    """Write the CA certificate, this container's certificate and its key to a folder
    only this user reads, once per container, and point the CANYONOS_REDIS_* TLS
    variables at them, for this process and every process it starts. Redis clients
    need files; gRPC takes the bytes. Does nothing without a certificate."""
    if not enabled():
        return
    with _export_lock:
        if all(
            os.path.isfile(os.environ.get(file_env, "")) for _, _, file_env in _FILES
        ):
            return
        folder = tempfile.mkdtemp(prefix="canyonos-tls-")
        for (_, file_name, file_env), pem in zip(_FILES, credentials()):
            path = os.path.join(folder, file_name)
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "wb") as output:
                output.write(pem)
            os.environ[file_env] = path
        os.environ[REDIS_TLS_ENV] = "true"
