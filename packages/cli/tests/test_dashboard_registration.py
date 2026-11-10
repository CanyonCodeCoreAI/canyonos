# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import io
import json
import urllib.error

import pytest

from canyonos import dashboard_registration, dashboard_stack


@pytest.fixture(autouse=True)
def api_port(monkeypatch):
    """The dashboard's API on a port its default isn't, as when 3000 was taken."""
    monkeypatch.setattr(
        dashboard_stack, "service_ports", lambda: {"api": 3005, "db": 5432}
    )


@pytest.fixture
def sent(monkeypatch):
    """Capture what reaches the api instead of opening a connection."""
    calls = []

    def urlopen(request, timeout):
        calls.append(
            {
                "url": request.full_url,
                "body": json.loads(request.data),
                "timeout": timeout,
            }
        )
        return io.BytesIO(b'{"spans": 3, "logs": 1, "metrics": 9}')

    monkeypatch.setattr(dashboard_registration.urllib.request, "urlopen", urlopen)
    return calls


def test_the_sample_data_request_names_the_workflow(sent):
    added = dashboard_registration.add_sample_data("p-1", "helloworld", api_port=3999)

    assert added == {"spans": 3, "logs": 1, "metrics": 9}
    assert sent[0]["url"] == "http://127.0.0.1:3999/projects/p-1/sample-data"
    assert sent[0]["body"] == {"workflow": "helloworld"}


def test_the_sample_data_request_waits_longer_than_registration(sent):
    """A recorded week is tens of thousands of rows: seconds on a fast machine,
    more on a slow one. Registration's 10s would cut a slow one off."""
    dashboard_registration.add_sample_data("p-1", "portfolio")

    assert sent[0]["timeout"] == dashboard_registration.SAMPLE_DATA_TIMEOUT_SECONDS
    assert sent[0]["timeout"] > dashboard_registration.TIMEOUT_SECONDS


def test_a_refusal_carries_the_apis_message(monkeypatch):
    def refuse(request, timeout):
        raise urllib.error.HTTPError(
            request.full_url,
            422,
            "Unprocessable",
            {},
            io.BytesIO(b'{"error": "validation", "message": "unknown workflow"}'),
        )

    monkeypatch.setattr(dashboard_registration.urllib.request, "urlopen", refuse)

    with pytest.raises(
        dashboard_registration.RegistrationError, match="unknown workflow"
    ):
        dashboard_registration.add_sample_data("p-1", "not-a-workflow")


def test_registration_and_sample_data_reach_the_api_where_it_is(sent, monkeypatch):
    monkeypatch.setattr(dashboard_registration, "join_project_network", lambda _n: None)
    dashboard_registration.register_project(6380)
    dashboard_registration.add_sample_data("p-1", "helloworld")

    assert sent[0]["url"] == "http://127.0.0.1:3005/canyonos/projects"
    assert sent[1]["url"] == "http://127.0.0.1:3005/projects/p-1/sample-data"
