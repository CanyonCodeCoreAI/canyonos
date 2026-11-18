# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The deployment's internal traffic on Docker is mutual TLS, signed by a CA of its
own: Redis refuses a plaintext client and a TLS client without a certificate the CA
signed, a gRPC call to a replica without one is refused, the CA stays in the CLI's
private folder and the Global Controller, and every other container holds only a
certificate of its own. The query cases that follow run on the same deploy, so a
workflow answering proves the traffic works end to end over TLS."""

import base64
import json
import os
import socket
import ssl

from cryptography import x509

from ..fleet import routed_replicas, store
from ..harness import (
    cli_value,
    docker,
    manifest,
    project_containers,
    qualified,
    redis_port,
    redis_tls_context,
)

CA_KEY_ENV = "CANYONOS_TLS_CA_KEY"
CERT_ENV = "CANYONOS_TLS_CERT"
KEY_ENV = "CANYONOS_TLS_KEY"
PING = b"*1\r\n$4\r\nPING\r\n"
# Asks the replica for a method it doesn't have: only a caller it let in hears
# UNIMPLEMENTED, so nothing runs whatever the answer.
GRPC_CHECK = """
import sys, grpc
from canyonos_core.controller.utils import internal_tls
from canyonos_core.controller.utils.grpc_options import open_channel
address = sys.argv[1]
def code(channel):
    try:
        channel.unary_unary("/canyonos.e2e.Nothing/Nothing")(b"", timeout=20)
        return "OK"
    except grpc.RpcError as error:
        return error.code().name
ca = internal_tls.credentials()[0]
no_certificate = grpc.ssl_channel_credentials(root_certificates=ca)
print(code(open_channel(address)), code(grpc.insecure_channel(address)),
      code(grpc.secure_channel(address, no_certificate)))
"""


def _ca_files(recorder, deployed) -> tuple[str, str]:
    cert, key = cli_value(
        recorder,
        deployed.dir,
        "ca_paths()",
        "from canyonos.internal_ca import ca_paths",
    )
    return cert, key


def _redis_answer(port: int, context: ssl.SSLContext | None = None) -> str:
    """What Redis on 127.0.0.1:`port` answers a PING with: its reply, '' when it closes
    the connection, or the error that refused it."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=10) as raw:
            connection = (
                context.wrap_socket(raw, server_hostname="127.0.0.1")
                if context
                else raw
            )
            with connection:
                connection.sendall(PING)
                return connection.recv(64).decode(errors="replace")
    except (ssl.SSLError, ConnectionError) as error:
        return f"refused: {error}"


def test_the_ca_is_private_to_the_cli(recorder, deployed):
    cert, key = _ca_files(recorder, deployed)
    for path in (cert, key):
        assert os.stat(path).st_mode & 0o777 == 0o600, (
            path,
            oct(os.stat(path).st_mode),
        )
    folder = os.path.dirname(key)
    assert os.stat(folder).st_mode & 0o777 == 0o700, oct(os.stat(folder).st_mode)
    with open(cert, "rb") as f:
        ca = x509.load_pem_x509_certificate(f.read())
    assert ca.extensions.get_extension_for_class(x509.BasicConstraints).value.ca


def test_redis_refuses_plaintext_and_tls_without_a_client_certificate(
    recorder, deployed
):
    port = redis_port(recorder, deployed.dir)
    plaintext = _redis_answer(port)
    assert not plaintext.startswith(("+", "-")), f"plaintext got {plaintext!r}"
    cert, _ = _ca_files(recorder, deployed)
    without_certificate = _redis_answer(port, ssl.create_default_context(cafile=cert))
    assert not without_certificate.startswith(("+", "-")), (
        f"TLS without a client certificate got {without_certificate!r}"
    )
    signed = _redis_answer(port, redis_tls_context(recorder, deployed.dir))
    assert signed.startswith("-NOAUTH"), f"a signed client got {signed!r}"


def test_a_grpc_call_without_a_client_certificate_is_refused(recorder, deployed):
    config = manifest(deployed.project_dir)
    databases = {
        qualified(deployed.project_dir, agent["name"])
        for agent in config.get("agents", [])
        if agent.get("type") == "database"
    }
    # Any agent replica serves gRPC; a database's address is its database port.
    agent = next(name for name in deployed.agents if name not in databases)
    routed = routed_replicas(store(recorder, deployed), agent)
    assert routed, f"{agent} has no routed replica"
    endpoint = next(
        name
        for name in project_containers(recorder, deployed.group)
        if name.startswith(f"{deployed.group}-endpoint-")
    )
    call = docker(
        recorder,
        ["exec", endpoint, "python", "-c", GRPC_CHECK, routed[0].address],
        timeout=120,
    )
    signed, plaintext, without_certificate = call.stdout.split()[-3:]
    assert signed == "UNIMPLEMENTED", f"{endpoint} with its certificate: {signed}"
    assert plaintext == "UNAVAILABLE", f"plaintext: {plaintext}"
    assert without_certificate == "UNAVAILABLE", (
        f"TLS without a client certificate: {without_certificate}"
    )


def test_only_the_global_controller_holds_the_ca_key(recorder, deployed):
    cert_path, key_path = _ca_files(recorder, deployed)
    with open(key_path, encoding="utf-8") as f:
        ca_key_pem = f.read()
    with open(cert_path, "rb") as f:
        ca = x509.load_pem_x509_certificate(f.read())
    ca_key_body = "".join(ca_key_pem.strip().splitlines()[1:-1])
    secrets = (ca_key_body, base64.b64encode(ca_key_pem.encode()).decode())
    gc = f"{deployed.group}-global-controller"
    containers = [
        name
        for name, state in project_containers(recorder, deployed.group).items()
        if state == "running" and name != gc
    ]
    assert containers, f"no running container in {deployed.group} but the GC"
    own_certificates = set()
    for container in containers:
        env = dict(
            line.split("=", 1)
            for line in json.loads(
                docker(
                    recorder, ["inspect", "-f", "{{json .Config.Env}}", container]
                ).stdout
            )
        )
        assert CA_KEY_ENV not in env, f"{container} has {CA_KEY_ENV}"
        files = docker(
            recorder,
            [
                "exec",
                container,
                "sh",
                "-c",
                "cat /tmp/canyonos-tls*/* 2>/dev/null; env",
            ],
            check=False,
        ).stdout
        for secret in secrets:
            assert secret not in json.dumps(env) and secret not in files, (
                f"{container} holds the CA's key"
            )
        assert env.get(KEY_ENV), f"{container} got no key of its own"
        certificate = x509.load_pem_x509_certificate(base64.b64decode(env[CERT_ENV]))
        assert certificate.issuer == ca.subject, f"{container}: {certificate.issuer}"
        assert not certificate.extensions.get_extension_for_class(
            x509.BasicConstraints
        ).value.ca, f"{container}'s certificate is a CA"
        own_certificates.add(env[CERT_ENV])
    assert len(own_certificates) == len(containers), "containers share a certificate"
    # Names only, so the CA's key stays out of the run's traces.
    names_only = '{{range .Config.Env}}{{index (split . "=") 0}} {{end}}'
    gc_env_names = docker(recorder, ["inspect", "-f", names_only, gc]).stdout.split()
    assert CA_KEY_ENV in gc_env_names, f"{gc} was not handed the CA"
