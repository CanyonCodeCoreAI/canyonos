# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The certificate authority of a deployment on Docker, which secures its internal
traffic with mutual TLS.

The first deploy makes it under `~/.canyonos/deployments/<deployment>/ca/`, readable
only by you, and every later deploy reuses it. The deploy hands it to the Global
Controller container, which signs a certificate for every container it starts:
Redis takes only TLS clients whose certificate this CA signed, and the controllers'
gRPC calls work the same way. Only a deployment whose `provider` is `local` gets one;
EC2 and Kubernetes keep their plaintext, password-protected Redis for now.

`packages/core/canyonos_core/controller/utils/internal_ca.py` signs the containers'
certificates and `internal_tls.py` reads them; the CLI cannot import canyonos_core,
so keep the variable names below in step with theirs.
"""

import base64
import datetime
import ipaddress
import os
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from canyonos import deployment
from canyonos.constants import deployment_config_path, read_config
from canyonos.docker_cmd import DOCKER_QUICK_TIMEOUT, run_docker
from canyonos.os_support import make_private_dir, write_private_file

CA_CERT_ENV = "CANYONOS_TLS_CA_CERT"
CA_KEY_ENV = "CANYONOS_TLS_CA_KEY"
CERT_ENV = "CANYONOS_TLS_CERT"
KEY_ENV = "CANYONOS_TLS_KEY"
CA_DAYS = 3650
CLIENT_DAYS = 825
TLS_PROVIDER = "local"


def ca_dir(name=None):
    """Return the folder that holds the CA of deployment `name`, by default this
    folder's."""
    return os.path.join(deployment.state_dir(name), "ca")


def ca_paths(name=None):
    """Return the CA's certificate and key files."""
    folder = ca_dir(name)
    return os.path.join(folder, "ca.crt"), os.path.join(folder, "ca.key")


def uses_internal_tls(config_path=None):
    """True when this folder's deployment runs on Docker with every agent on this
    machine, the only deployments whose internal traffic is TLS for now."""
    config = read_config(config_path or deployment_config_path())
    provider = config.get("provider") if isinstance(config, dict) else None
    return (
        deployment.configured_target(config_path) == "docker"
        and str(provider or TLS_PROVIDER).casefold() == TLS_PROVIDER
    )


def refuse_redis_that_outlived_its_ca():
    """Raise when this deployment's Redis container still runs on the active Docker
    engine but its CA is gone: Redis would refuse every certificate a new CA signs."""
    if not uses_internal_tls() or all(map(os.path.isfile, ca_paths())):
        return
    inspect = run_docker(
        [
            "docker",
            "inspect",
            "--format",
            "{{.State.Running}}",
            deployment.redis_container_name(),
        ],
        timeout=DOCKER_QUICK_TIMEOUT,
        action="Looking for this deployment's Redis container",
    )
    if inspect.returncode != 0 or inspect.stdout.strip() != "true":
        return
    name = deployment.deployment_name()
    raise RuntimeError(
        f"{name}'s Redis is still running, but its certificate authority {ca_dir()} "
        "is gone, so Redis would refuse the certificates a new one signs. Run "
        f"`canyonos stop {name}` (or `docker rm -f -v "
        f"{deployment.redis_container_name()}`), then deploy again."
    )


def _new_ca(name):
    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name(
        [x509.NameAttribute(NameOID.COMMON_NAME, f"CanyonOS {name} internal CA")]
    )
    now = datetime.datetime.now(datetime.timezone.utc)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(hours=1))
        .not_valid_after(now + datetime.timedelta(days=CA_DAYS))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=False,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False
        )
        .sign(key, hashes.SHA256())
    )
    key_pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    return certificate.public_bytes(serialization.Encoding.PEM), key_pem


def ensure_ca(name=None):
    """Return the CA certificate and key of deployment `name`, by default this
    folder's, as PEM bytes, made on its first use and kept after."""
    cert_path, key_path = ca_paths(name)
    if not (os.path.isfile(cert_path) and os.path.isfile(key_path)):
        make_private_dir(Path(ca_dir(name)))
        cert, key = _new_ca(name or deployment.deployment_name())
        write_private_file(key_path, key.decode())
        write_private_file(cert_path, cert.decode())
    with open(cert_path, "rb") as cert_file, open(key_path, "rb") as key_file:
        return cert_file.read(), key_file.read()


def gc_env():
    """The variables that hand the Global Controller container this deployment's CA,
    made on the first deploy, and its own client certificate, for its Redis clients;
    none when its internal traffic is not TLS. The docker command copies them from its
    environment, so they stay off the command line."""
    if not uses_internal_tls():
        return {}
    ca_cert, ca_key = ensure_ca()
    own = client_certificate("global-controller")
    return {
        CA_CERT_ENV: base64.b64encode(ca_cert).decode(),
        CA_KEY_ENV: base64.b64encode(ca_key).decode(),
        CERT_ENV: base64.b64encode(own["cert"].encode()).decode(),
        KEY_ENV: base64.b64encode(own["key"].encode()).decode(),
    }


def client_certificate(common_name, name=None):
    """A client certificate the CA of deployment `name` signs, for a process outside
    the deployment that reads its Redis, such as the dashboard: `{ca, cert, key}` as
    PEM text, or None when the deployment's internal traffic is not TLS or it has no
    CA yet. It also names 127.0.0.1 and localhost, the Redis a host process reaches."""
    cert_path, key_path = ca_paths(name)
    if not (uses_internal_tls() and os.path.isfile(cert_path)):
        return None
    with open(cert_path, "rb") as cert_file, open(key_path, "rb") as key_file:
        ca_cert = x509.load_pem_x509_certificate(cert_file.read())
        ca_key = serialization.load_pem_private_key(key_file.read(), password=None)
    if not isinstance(ca_key, ec.EllipticCurvePrivateKey):
        raise RuntimeError(f"{key_path} is not the EC key `canyonos deploy` makes")
    key = ec.generate_private_key(ec.SECP256R1())
    now = datetime.datetime.now(datetime.timezone.utc)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)]))
        .issuer_name(ca_cert.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(hours=1))
        .not_valid_after(now + datetime.timedelta(days=CLIENT_DAYS))
        .add_extension(
            x509.SubjectAlternativeName(
                [
                    x509.DNSName(common_name),
                    x509.DNSName("localhost"),
                    x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
                ]
            ),
            critical=False,
        )
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH]), critical=False
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()),
            critical=False,
        )
        .sign(ca_key, hashes.SHA256())
    )
    return {
        "ca": ca_cert.public_bytes(serialization.Encoding.PEM).decode(),
        "cert": certificate.public_bytes(serialization.Encoding.PEM).decode(),
        "key": key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode(),
    }
