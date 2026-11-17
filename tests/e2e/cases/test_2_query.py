# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Queries through the deployed endpoint: a queued query answers 202, and the test
query gives a result the project's own check accepts, through the REST API and
through `canyonos test`, which sends its default query when given none in a
deployment folder; on projects that call no model, twenty queries in a row all
finish; a finished request stays readable after cleanup; a bad body and an unknown
request are refused; a plain hex string is not taken for a Future on projects that
take any text; and a failing agent is named in the error.

Every route needs a query token for the project, signed by a trusted key: the
shared token vectors get the verdicts their file states, and a missing, foreign,
misplaced or unpublished key is refused before the body is read."""

import base64
import json
import re
import uuid

import pytest

from ..harness import (
    as_argument,
    bearer,
    canyonos,
    cli_value,
    finished,
    http,
    poll,
    project_redis,
    project_root,
    result_of,
    submit,
    token,
    vectors,
)

RESULT_CHARACTERS = 4000
CLEANUP_TIMEOUT = 240
HEX_QUERY = "deadbeefdeadbeef"
TRUSTED_KEYS_KEY = "auth:trusted_keys"
IDENTITY_KEY = "controller:identity"
NOT_READY = {
    "error": "The endpoint is starting; the Global Controller has not published its "
    "trusted keys yet",
    "error_name": "auth.not_ready",
}
JWT_LINE = re.compile(r"[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+")
JWT_ANYWHERE = re.compile(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")


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
    signed = "Signed a query token with"
    assert signed in call.output and signed not in call.stdout, call.output
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
    problems = _problems(check, report["results"][0]["result"], query=query)
    assert not problems, problems


def test_canyonos_test_without_a_query_sends_test_query_txt(recorder, deployed, check):
    path = project_root(deployed.project_dir) / "config" / "test_query.txt"
    report = _canyonos_test(recorder, deployed)
    query = path.read_text().strip()
    assert report["results"][0]["query"] == query, report
    problems = _problems(check, report["results"][0]["result"], query=query)
    assert not problems, problems


@pytest.mark.trait("quick")
def test_twenty_queries_in_a_row_all_finish(recorder, deployed, check):
    if "llm" in deployed.project.traits:
        pytest.skip("the AWS account's model rate limit can't take 20 queries in a row")
    timeout = deployed.project.timeout
    for _ in range(20):
        request_id, result = result_of(
            recorder, deployed.endpoint, deployed.query, timeout=timeout
        )
        problems = _problems(check, result, query=deployed.query, request_id=request_id)
        assert not problems, problems


def test_status_answers_after_cleanup(recorder, deployed, query_result):
    store = project_redis(recorder, deployed.dir)
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
    status = http(recorder, "GET", url, headers=deployed.endpoint.headers).json()
    expected = {
        "request_id": query_result.request_id,
        "status": "done",
        "result": query_result.result,
    }
    assert status == expected, status


def test_missing_argument_is_refused(recorder, deployed):
    url = f"{deployed.endpoint.url}/{deployed.endpoint.route}"
    call = http(
        recorder, "POST", url, json={}, headers=deployed.endpoint.headers, check=False
    )
    assert call.code == 400, call.output
    assert f"Missing argument(s) {deployed.endpoint.argument}" in call.output


def test_unknown_request_is_not_found(recorder, deployed):
    url = f"{deployed.endpoint.url}/status/{uuid.uuid4().hex}"
    call = http(recorder, "GET", url, headers=deployed.endpoint.headers, check=False)
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


def _query_url(deployed) -> str:
    return f"{deployed.endpoint.url}/{deployed.endpoint.route}"


def _post_query(recorder, deployed, headers):
    return http(
        recorder,
        "POST",
        _query_url(deployed),
        json={deployed.endpoint.argument: deployed.query},
        headers=headers,
        check=False,
    )


def _assert_refused(call, code: str, status: int = 401) -> None:
    assert call.code == status, call.output
    body = call.json()
    assert set(body) == {"error", "error_name"}, call.output
    assert body["error_name"] == code, call.output
    assert body["error"], call.output


@pytest.mark.parametrize("vector", vectors(), ids=lambda vector: vector["name"])
def test_token_vector(recorder, deployed, vector):
    expect = vector["expect"]["endpoint"]
    url = f"{deployed.endpoint.url}/status/nothing"
    call = http(recorder, "GET", url, headers=bearer(vector["token"]), check=False)
    assert call.code == expect["status"], call.output
    if "code" in expect:
        assert call.json()["error_name"] == expect["code"], call.output


def test_every_route_needs_a_token(recorder, deployed, query_result):
    request_id = query_result.request_id
    base = deployed.endpoint.url
    calls = [
        http(
            recorder,
            "POST",
            _query_url(deployed),
            json={deployed.endpoint.argument: deployed.query},
            check=False,
        ),
        http(recorder, "GET", f"{base}/status/{request_id}", check=False),
        http(
            recorder,
            "POST",
            f"{base}/answer/{request_id}",
            json={"input": "x"},
            check=False,
        ),
    ]
    for call in calls:
        _assert_refused(call, "auth.missing_token")
        assert "result" not in call.json(), call.output


def test_the_token_is_checked_before_the_body(recorder, deployed):
    call = http(recorder, "POST", _query_url(deployed), json={}, check=False)
    _assert_refused(call, "auth.missing_token")


def test_a_key_no_deploy_trusts_is_refused(recorder, deployed, tmp_path):
    foreign = str(tmp_path / "auth")
    canyonos(recorder, ["keys", "create", "--auth-dir", foreign], cwd=deployed.dir)
    signed = token(
        recorder,
        deployed.dir,
        "--scope",
        "query",
        "--project",
        deployed.project_id,
        "--auth-dir",
        foreign,
    )
    _assert_refused(
        _post_query(recorder, deployed, bearer(signed)), "auth.invalid_token"
    )


def test_a_token_for_several_projects_includes_this_one(recorder, deployed):
    signed = token(
        recorder,
        deployed.dir,
        "--scope",
        "query",
        "--project",
        str(uuid.uuid4()),
        "--project",
        deployed.project_id,
    )
    call = _post_query(recorder, deployed, bearer(signed))
    assert call.code == 202, call.output
    status = finished(
        recorder,
        deployed.endpoint,
        call.json()["request_id"],
        timeout=deployed.project.timeout,
    )
    assert status["status"] == "done", status


def test_a_dashboard_token_does_not_query(recorder, deployed):
    signed = token(recorder, deployed.dir, "--scope", "read")
    _assert_refused(
        _post_query(recorder, deployed, bearer(signed)), "auth.invalid_token"
    )


def test_only_a_bearer_header_carries_the_token(recorder, deployed):
    basic = base64.b64encode(f"e2e:{deployed.endpoint.token}".encode()).decode()
    for header in (deployed.endpoint.token, f"Basic {basic}"):
        call = _post_query(recorder, deployed, {"Authorization": header})
        _assert_refused(call, "auth.missing_token")


def test_the_endpoint_waits_for_the_published_keys(recorder, deployed):
    store = project_redis(recorder, deployed.dir)
    record = store.get(TRUSTED_KEYS_KEY)
    project_id = store.hget(IDENTITY_KEY, "project_id")
    assert record and project_id == deployed.project_id, (record, project_id)
    try:
        store.delete(TRUSTED_KEYS_KEY)
        for headers in (deployed.endpoint.headers, {}):
            call = _post_query(recorder, deployed, headers)
            assert call.code == 503, call.output
            assert call.json() == NOT_READY, call.output
        store.set(TRUSTED_KEYS_KEY, record)
        store.hdel(IDENTITY_KEY, "project_id")
        call = _post_query(recorder, deployed, deployed.endpoint.headers)
        assert call.code == 503, call.output
        assert call.json() == NOT_READY, call.output
    finally:
        store.set(TRUSTED_KEYS_KEY, record)
        store.hset(IDENTITY_KEY, "project_id", project_id)
    call = _post_query(recorder, deployed, deployed.endpoint.headers)
    assert call.code == 202, call.output


@pytest.mark.trait("quick")
def test_canyonos_test_signs_its_own_token_and_never_shows_it(recorder, deployed):
    timeout = deployed.project.timeout
    call = canyonos(
        recorder,
        ["test", cli_query(deployed), "--timeout", str(timeout)],
        cwd=deployed.dir,
        timeout=timeout + 120,
    )
    key = cli_value(
        recorder,
        deployed.dir,
        f"str(private_key_path(None, Path({str(recorder.auth_dir)!r})))",
        "from pathlib import Path; from canyonos.auth import private_key_path",
    )
    signed = f"Signed a query token with {key}"
    assert call.output.count(signed) == 1, call.output
    lines = [line.strip() for line in call.output.splitlines()]
    assert not [line for line in lines if JWT_LINE.fullmatch(line)], call.output
    assert not JWT_ANYWHERE.search(call.output), call.output
