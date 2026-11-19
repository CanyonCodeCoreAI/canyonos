# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

# Keepalive options for gRPC channels/servers so idle connections get detected instead of stalling

"""
grpc.keepalive_time_ms (int) - time period sender pings the server.
grpc.keepalive_timeout_ms (int) - time server waits for the ping before erroring
grpc.keepalive_permit_without_calls (bool) - allows for sender to send requests even when no active stream is open
grpc.http2.max_pings_without_data (int) - allows sender to send # of pings in a row without sending real data, putting it at 0 removes the limit
grpc.http2.min_ping_interval_without_data_ms (int) - the period of time the server would accept pings without blocking the sender (default: 5 minutes)
"""

import logging
import time

import grpc

try:
    from canyonos_core.controller.utils import internal_tls
except ImportError:
    import canyonos_internal_tls as internal_tls

logger = logging.getLogger(__name__)

GRPC_CHANNEL_OPTIONS = [
    ("grpc.keepalive_time_ms", 30000),
    ("grpc.keepalive_timeout_ms", 10000),
    ("grpc.keepalive_permit_without_calls", 1),
    ("grpc.http2.max_pings_without_data", 0),
]

GRPC_SERVER_OPTIONS = [
    ("grpc.keepalive_time_ms", 30000),
    ("grpc.keepalive_timeout_ms", 10000),
    ("grpc.keepalive_permit_without_calls", 1),
    ("grpc.http2.max_pings_without_data", 0),
    ("grpc.http2.min_ping_interval_without_data_ms", 10000),
]


def open_channel(address):
    """A channel to the controller at `address`. With this container's certificate
    (Docker), mutual TLS: it presents the certificate and accepts only a server whose
    certificate the workflow group's CA signed for `address`'s host. Without one, plaintext."""
    if not internal_tls.enabled():
        return grpc.insecure_channel(address, options=GRPC_CHANNEL_OPTIONS)
    ca, cert, key = internal_tls.credentials()
    credentials = grpc.ssl_channel_credentials(
        root_certificates=ca, private_key=key, certificate_chain=cert
    )
    return grpc.secure_channel(address, credentials, options=GRPC_CHANNEL_OPTIONS)


def add_server_port(server, port):
    """Serve `server` on `port` on every interface. With this container's certificate
    (Docker), mutual TLS: a caller without a certificate the workflow group's CA signed is
    refused before any call. Without one, plaintext."""
    address = f"[::]:{port}"
    if not internal_tls.enabled():
        return server.add_insecure_port(address)
    ca, cert, key = internal_tls.credentials()
    credentials = grpc.ssl_server_credentials(
        [(key, cert)], root_certificates=ca, require_client_auth=True
    )
    return server.add_secure_port(address, credentials)


def call_with_retry(fn, address):
    """Call a remote stub RPC, retrying transient UNAVAILABLE before raising."""
    max_attempts = 8
    backoff = 0.5
    for attempt in range(1, max_attempts + 1):
        try:
            return fn()
        except grpc.RpcError as e:
            if (
                not isinstance(e, grpc.Call)
                or e.code() != grpc.StatusCode.UNAVAILABLE
                or attempt == max_attempts
            ):
                raise
            logger.warning(
                "Transient UNAVAILABLE calling %s (attempt %d/%d), retrying in %.1fs",
                address,
                attempt,
                max_attempts,
                backoff,
            )
            time.sleep(backoff)
            backoff = min(backoff * 2, 8)
