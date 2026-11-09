# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Queries through the deployed endpoint: the test query gives a result the
project's own check accepts, through the REST API and through `canyonos test`,
which sends the project's config/test_query.txt when given no query; a
finished request stays readable after cleanup; a bad body and an unknown request
are refused; a plain hex string is not taken for a Future on projects that take
any text; and a failing agent is named in the error."""

import json
import uuid

import pytest
import redis

from ..harness import (
    as_argument,
    canyonos,
    finished,
    http,
    poll,
    project_root,
    redis_port,
    submit,
)

RESULT_CHARACTERS = 4000
CLEANUP_TIMEOUT = 240
HEX_QUERY = "deadbeefdeadbeef"


def _problems(check, result, **context):
    found = list(check.problems(result, **context))
    return (
        "\n".join([*found, f"result: {json.dumps(result)[:RESULT_CHARACTERS]}"])
        if found
        else ""
    )


def cli_query(deployed) -> str:
    """The query as `canyonos test` takes it: project.yaml's `cli_query` when the
    workflow reads the command line's text in its own form, else the REST query."""
    return deployed.project.cli_query or as_argument(deployed.endpoint, deployed.query)


def _canyonos_test(recorder, deployed, *query):
    timeout = deployed.project.timeout
    call = canyonos(
        recorder,
        ["test", *query, "--json", "--timeout", str(timeout)],
        cwd=deployed.dir,
        timeout=timeout + 120,
    )
    report = call.json()
    assert report["against_existing_deploy"] is True, call.stdout
    return report


def test_query_result_is_real(query_result, deployed, check):
    problems = _problems(
        check,
        query_result.result,
        query=deployed.query,
        request_id=query_result.request_id,
    )
    assert not problems, problems


@pytest.mark.trait("quick")
def test_canyonos_test_reports_a_real_result(recorder, deployed, check):
    query = cli_query(deployed)
    report = _canyonos_test(recorder, deployed, query)
    assert report["query"] == query, report
    problems = _problems(check, report["result"], query=query)
    assert not problems, problems


@pytest.mark.trait("quick")
def test_canyonos_test_without_a_query_sends_test_query_txt(recorder, deployed, check):
    path = project_root(deployed.dir) / "config" / "test_query.txt"
    report = _canyonos_test(recorder, deployed)
    query = path.read_text().strip()
    assert report["query"] == query, report
    problems = _problems(check, report["result"], query=query)
    assert not problems, problems


def test_status_answers_after_cleanup(recorder, deployed, query_result):
    port = redis_port(recorder, deployed.dir)
    store = redis.Redis(host="127.0.0.1", port=port, decode_responses=True)
    request = f"request:{query_result.request_id}"

    def cleaned_up():
        live = store.exists(f"{request}:futures", f"{request}:future")
        return not live and store.exists(f"{request}:result")

    poll(
        cleaned_up,
        timeout=CLEANUP_TIMEOUT,
        what=f"cleanup to move {request} to {request}:result",
    )
    url = f"{deployed.endpoint.url}/status/{query_result.request_id}"
    status = http(recorder, "GET", url).json()
    expected = {
        "request_id": query_result.request_id,
        "status": "done",
        "result": query_result.result,
    }
    assert status == expected, status


def test_missing_argument_is_refused(recorder, deployed):
    url = f"{deployed.endpoint.url}/{deployed.endpoint.route}"
    call = http(recorder, "POST", url, json={}, check=False)
    assert call.code == 400, call.output
    assert f"Missing argument(s) {deployed.endpoint.argument}" in call.output


def test_unknown_request_is_not_found(recorder, deployed):
    url = f"{deployed.endpoint.url}/status/{uuid.uuid4().hex}"
    call = http(recorder, "GET", url, check=False)
    assert call.code == 404, call.output
    assert call.json() == {"error": "Request not found"}, call.output


@pytest.mark.trait("text-query")
def test_hex_argument_is_not_a_future(recorder, deployed, check):
    """A 16-hex-character argument is text, not a Future id to wait for (CAN-452)."""
    request_id = submit(recorder, deployed.endpoint, HEX_QUERY)
    timeout = deployed.project.timeout
    status = finished(recorder, deployed.endpoint, request_id, timeout=timeout)
    assert status["status"] == "done", status
    problems = _problems(check, status["result"], query=HEX_QUERY)
    assert not problems, problems


@pytest.mark.trait("failing-query")
def test_failing_agent_is_named(recorder, deployed, check):
    """The error text comes from the model's parse of the query, so this depends
    on the model refusing to find holdings in it."""
    query, expected = check.FAILING_QUERY
    request_id = submit(recorder, deployed.endpoint, query)
    status = finished(recorder, deployed.endpoint, request_id, timeout=120)
    assert status["status"] == "error", status
    assert expected in (status.get("error") or ""), status
