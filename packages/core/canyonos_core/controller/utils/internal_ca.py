# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The workflow group's certificate authority, as the Global Controller container holds it.

`canyonos deploy` makes the CA on a workflow group's first deploy, keeps it under
`~/.canyonos/deployments/<workflow group>/ca/` and hands it to the Global Controller
container in `CANYONOS_TLS_CA_CERT` and `CANYONOS_TLS_CA_KEY`. The Global Controller and
the reconciler sign a certificate for every container they start (Redis, the metrics
collector, each replica) and hand it over as an env file, so the CA's key never leaves
this container. No CA in the environment (EC2, Kubernetes) means no certificates, and
internal traffic stays plaintext.
"""

import base64
import datetime
import ipaddress
import os
import tempfile
from contextlib import contextmanager

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from canyonos_core.controller.utils import internal_tls

CA_KEY_ENV = "CANYONOS_TLS_CA_KEY"
# Every certificate also names this container's loopback, which a container's own
# processes dial (an agent's Future reaches its controller at localhost).
LOOPBACK_NAMES = ("localhost",)
LOOPBACK_IPS = ("127.0.0.1", "::1")
# Long enough that a Redis kept across redeploys outlives no certificate of its own.
CERTIFICATE_DAYS = 825


def available(environ=None):
    """True when this container holds the workflow group's CA, so what it starts gets
    certificates."""
    env = os.environ if environ is None else environ
    return bool(env.get(internal_tls.CA_CERT_ENV) and env.get(CA_KEY_ENV))


def _ca():
    ca_cert = x509.load_pem_x509_certificate(
        base64.b64decode(os.environ[internal_tls.CA_CERT_ENV])
    )
    ca_key = serialization.load_pem_private_key(
        base64.b64decode(os.environ[CA_KEY_ENV]), password=None
    )
    if not isinstance(ca_key, ec.EllipticCurvePrivateKey):
        raise RuntimeError(
            f"{CA_KEY_ENV} does not hold the EC key `canyonos deploy` makes"
        )
    return ca_cert, ca_key


def sign(names):
    """A new key and a certificate for it, signed by the workflow group's CA, valid as a
    server and as a client for the DNS `names` and this container's loopback. Returns
    both as PEM bytes."""
    ca_cert, ca_key = _ca()
    key = ec.generate_private_key(ec.SECP256R1())
    dns_names = list(dict.fromkeys([*names, *LOOPBACK_NAMES]))
    now = datetime.datetime.now(datetime.timezone.utc)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(
            x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, dns_names[0])])
        )
        .issuer_name(ca_cert.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        # A clock a little behind the CLI's still accepts it.
        .not_valid_before(now - datetime.timedelta(hours=1))
        .not_valid_after(now + datetime.timedelta(days=CERTIFICATE_DAYS))
        .add_extension(
            x509.SubjectAlternativeName(
                [x509.DNSName(name) for name in dns_names]
                + [x509.IPAddress(ipaddress.ip_address(ip)) for ip in LOOPBACK_IPS]
            ),
            critical=False,
        )
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=True,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.ExtendedKeyUsage(
                [ExtendedKeyUsageOID.SERVER_AUTH, ExtendedKeyUsageOID.CLIENT_AUTH]
            ),
            critical=False,
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()),
            critical=False,
        )
        .sign(ca_key, hashes.SHA256())
    )
    key_pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    return certificate.public_bytes(serialization.Encoding.PEM), key_pem


def certificate_env(names):
    """The variables that give a container the CA's certificate and its own certificate
    and key for `names`, base64 as `internal_tls` reads them. Never the CA's key."""
    cert, key = sign(names)
    return {
        internal_tls.CA_CERT_ENV: os.environ[internal_tls.CA_CERT_ENV],
        internal_tls.CERT_ENV: base64.b64encode(cert).decode(),
        internal_tls.KEY_ENV: base64.b64encode(key).decode(),
    }


@contextmanager
def certificate_env_file_args(names):
    """Yield the `docker run` flags that hand a container on this machine its
    certificate for `names` in a private env file, deleted once the `with` body ends,
    by when `docker run` has read it; no flags without a CA. Keep the body tight
    around `docker run`. The values stay off the command line."""
    if not available():
        yield []
        return
    descriptor, path = tempfile.mkstemp(prefix="canyonos-tls-", suffix=".env")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            for name, value in certificate_env(names).items():
                output.write(f"{name}={value}\n")
        yield ["--env-file", path]
    finally:
        os.remove(path)
