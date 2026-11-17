# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The bearer tokens that let a caller query a workflow. The Global Controller reads
the public keys `canyonos deploy` trusts from its environment and publishes them to
Redis; the endpoint verifies each request's token against them."""

import json

import jwt
from cryptography.exceptions import UnsupportedAlgorithm
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import load_pem_public_key

# packages/cli/canyonos/auth.py repeats these on purpose: the CLI cannot import
# canyonos_core, and both sides must agree on them.
ISSUER = "canyonos"
API_AUDIENCE = "canyonos-api"
ALL_PROJECTS = "*"
SCOPES = ("query", "read", "write")
TRUSTED_KEYS_ENV = "CANYONOS_TRUSTED_KEYS"
AUTH_DISABLED_ENV = "CANYONOS_AUTH_DISABLED"

TRUSTED_KEYS_KEY = "auth:trusted_keys"
# How far apart a signer's clock and a verifier's may be for `exp`; the dashboard
# API gives jose the same clockTolerance. Like jose, the endpoint ignores `iat`, so
# a signer whose clock runs ahead is not refused at one verifier only.
CLOCK_LEEWAY_SECONDS = 60


class AuthError(Exception):
    """A request refused for its token: `code` names the refusal (such as
    `auth.invalid_token`), `message` says why, and `status` is the HTTP status to
    answer with."""

    def __init__(self, code: str, message: str, status: int):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def _public_keys(raw: str) -> list[str]:
    try:
        keys = json.loads(raw)
    except ValueError:
        keys = None
    if not isinstance(keys, list) or not all(isinstance(key, str) for key in keys):
        raise RuntimeError(
            f"{TRUSTED_KEYS_ENV} must be a JSON list of PEM public keys, as "
            "`canyonos deploy` sets it"
        )
    for index, pem in enumerate(keys):
        try:
            key = load_pem_public_key(pem.encode())
        except (ValueError, UnsupportedAlgorithm):
            key = None
        if not isinstance(key, Ed25519PublicKey):
            raise RuntimeError(
                f"{TRUSTED_KEYS_ENV}[{index}] is not an Ed25519 public key in PEM"
            )
    return keys


def _disabled(raw: str) -> bool:
    if raw not in ("", "true", "false"):
        raise RuntimeError(f"{AUTH_DISABLED_ENV} must be true or false, not {raw!r}")
    return raw == "true"


def trusted_keys_from_env(environ) -> dict:
    """The record the Global Controller publishes under `TRUSTED_KEYS_KEY`: the public
    keys the deploy trusts and whether it turned verification off. Raise RuntimeError
    naming the variable when either is malformed, so the Global Controller does not
    start on a config it cannot enforce."""
    return {
        "keys": _public_keys(environ.get(TRUSTED_KEYS_ENV) or "[]"),
        "disabled": _disabled(environ.get(AUTH_DISABLED_ENV, "")),
    }


def _audience_of(token: str, pem: str) -> list[str]:
    """The `aud` of a token signed by `pem`, as a list of strings; empty when it
    has another shape."""
    try:
        claims = jwt.decode(
            token,
            pem,
            algorithms=["EdDSA"],
            options={
                "verify_exp": False,
                "verify_nbf": False,
                "verify_iat": False,
                "verify_iss": False,
                "verify_aud": False,
                "verify_sub": False,
                "verify_jti": False,
            },
        )
    except jwt.PyJWTError:
        return []
    audience = claims.get("aud")
    if isinstance(audience, str):
        return [audience]
    if isinstance(audience, list) and all(isinstance(a, str) for a in audience):
        return audience
    return []


def _audience_refusal(token: str, pem: str, audiences: list[str]) -> AuthError:
    """The refusal of a token signed by `pem`, a trusted key, but meant for someone
    else, naming what it is for when that can be told."""
    audience = _audience_of(token, pem)
    if API_AUDIENCE in audience and API_AUDIENCE not in audiences:
        message = "This token is for the dashboard API, not for a workflow"
    elif API_AUDIENCE in audiences and audience:
        message = "This token is for a workflow, not for the dashboard API"
    else:
        message = "This token is not for this project"
    return AuthError("auth.invalid_token", message, 401)


def _claims(token: str, trusted_pems: list[str], audiences: list[str]) -> dict:
    """The token's claims, verified against the first trusted key that signed it."""
    for pem in trusted_pems:
        try:
            return jwt.decode(
                token,
                pem,
                algorithms=["EdDSA"],
                audience=audiences,
                issuer=ISSUER,
                leeway=CLOCK_LEEWAY_SECONDS,
                options={"require": ["iss", "aud", "scope"], "verify_iat": False},
            )
        except jwt.InvalidSignatureError:
            continue
        except jwt.ExpiredSignatureError:
            raise AuthError("auth.invalid_token", "This token expired", 401) from None
        except jwt.InvalidAudienceError:
            raise _audience_refusal(token, pem, audiences) from None
        except (jwt.PyJWTError, TypeError, ValueError) as error:
            raise AuthError(
                "auth.invalid_token", f"This token is not valid: {error}", 401
            ) from None
    raise AuthError(
        "auth.invalid_token",
        "This token is not signed by a key this deploy trusts",
        401,
    )


def verify_bearer(
    token: str, trusted_pems: list[str], *, audiences: list[str], scope: str
) -> dict:
    """The claims of `token` once it is signed by one of `trusted_pems`, unexpired,
    for one of `audiences` and of exactly `scope`; raise AuthError otherwise, 401 for
    a token that is not valid here and 403 for a valid one of another scope."""
    claims = _claims(token, trusted_pems, audiences)
    granted = claims["scope"]
    if granted not in SCOPES:
        raise AuthError(
            "auth.invalid_token",
            f"This token's scope is not one of {', '.join(SCOPES)}",
            401,
        )
    if granted != scope:
        raise AuthError(
            "auth.insufficient_scope",
            f"This token's scope is {granted}, and this needs {scope}",
            403,
        )
    return claims
