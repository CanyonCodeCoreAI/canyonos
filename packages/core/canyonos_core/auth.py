# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The machine's API key, which lets a caller query a workflow. The Global Controller
reads the key's SHA-256 hash from its environment and publishes it to Redis; the
endpoint compares the hash of each request's bearer with it. No hash means no check."""

import hashlib
import hmac
import re

# packages/cli/canyonos/auth.py repeats this on purpose: the CLI cannot import
# canyonos_core, and both sides must agree on it.
API_KEY_HASH_ENV = "CANYONOS_API_KEY_HASH"
API_KEY_HASH_KEY = "auth:api_key_hash"

_HASH = re.compile(r"[0-9a-f]{64}")


def hash_api_key(key: str) -> str:
    """The SHA-256 of `key`, as the lowercase hex the verifiers hold."""
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def api_key_hash_from_env(environ) -> str:
    """The API key hash `canyonos deploy` set, or "" when it set none and every request
    passes; raise RuntimeError naming the variable when it is not a SHA-256 in hex, so
    the Global Controller does not start on a config it cannot enforce."""
    value = (environ.get(API_KEY_HASH_ENV) or "").strip()
    if value and not _HASH.fullmatch(value):
        raise RuntimeError(
            f"{API_KEY_HASH_ENV} must be the SHA-256 of the API key in lowercase hex, "
            "as `canyonos deploy` sets it"
        )
    return value


def bearer_key(header: str) -> str | None:
    """The key of an `Authorization: Bearer <key>` header, the scheme in any case;
    None for any other header."""
    scheme, _, key = header.strip().partition(" ")
    if scheme.lower() != "bearer" or not key.strip():
        return None
    return key.strip()


def key_matches(key: str, expected_hash: str) -> bool:
    """True when `key` hashes to `expected_hash`, compared in constant time."""
    return hmac.compare_digest(hash_api_key(key), expected_hash)
