# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import io
import json
import urllib.error

import pytest

from canyonos import gc


class _Response:
    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self.body


def test_gc_requests_are_bounded(monkeypatch):
    seen = {}

    def urlopen(_request, **kwargs):
        seen.update(kwargs)
        return _Response(b"{}")

    monkeypatch.setattr(gc.urllib.request, "urlopen", urlopen)

    gc.post_clean(8000)

    assert seen == {"timeout": gc.CLEAN_REQUEST_TIMEOUT_SECONDS}


@pytest.mark.parametrize("body", [b"not-json", b"[]", b"null"])
def test_malformed_success_response_becomes_gc_error(monkeypatch, body):
    monkeypatch.setattr(gc.urllib.request, "urlopen", lambda *_a, **_k: _Response(body))

    with pytest.raises(gc.GCError, match="invalid"):
        gc.post_clean(8000)


def test_non_mapping_http_error_keeps_the_original_body():
    error = urllib.error.HTTPError(
        "http://localhost",
        500,
        "error",
        {},
        io.BytesIO(json.dumps(["broken"]).encode()),
    )

    assert gc._error_detail(error) == '["broken"]'


@pytest.mark.parametrize("body", [b"not-json", b"[]", b"null"])
def test_malformed_status_response_is_not_reported_as_stopped(monkeypatch, body):
    """None means "couldn't tell", which the caller counts as a miss -- a
    verdict of "running" would be the dangerous answer here, not an exception."""
    monkeypatch.setattr(gc.urllib.request, "urlopen", lambda *_a, **_k: _Response(body))

    assert gc.deploy_status(8000) is None
