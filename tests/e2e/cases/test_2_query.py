# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Queries through the deployed endpoint: a queued query answers 202, and the test
query gives a result the workflow's own check accepts, through the REST API and
through `canyonos test`, which sends its default query when given none in a
workflow group folder; twenty queries sent at once all finish; a finished request stays readable after cleanup; a bad body and an unknown
request are refused; a plain hex string is not taken for a Future on workflows that
take any text; and a failing agent is named in the error.

Every route needs the session's API key as a bearer, the scheme in any case: a
missing, wrong or misplaced key is refused before the body is read, and nothing
passes until the Global Controller has published the key's hash."""

import base64
import json
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest

from ..harness import (
    as_argument,
    bearer,
    canyonos,
    finished,
    hash_api_key,
    http,
    poll,
    workflow_group_redis,
    workflow_config_dir,
    result_of,
    submit,
)

RESULT_CHARACTERS = 4000
CLEANUP_TIMEOUT = 240
HEX_QUERY = "deadbeefdeadbeef"
API_KEY_HASH_KEY = "auth:api_key_hash"
IDENTITY_KEY = "controller:identity"


def _problems(check, result, **context):
    found = list(check.problems(result, **context))
    return (
        "\n".join([*found, f"result: {json.dumps(result)[:RESULT_CHARACTERS]}"])
        if found
        else ""
    )


def cli_query(deployed) -> str:
    """The query as `canyonos test` takes it: workflow.yaml's `cli_query` when the
    workflow reads the command line's text in its own form, else the REST query."""
    return deployed.workflow.cli_query or as_argument(deployed.endpoint, deployed.query)


def _canyonos_test(recorder, deployed, *query):
    timeout = deployed.workflow.timeout
    call = canyonos(
        recorder,
        ["test", *query, "--json", "--timeout", str(timeout)],
        cwd=deployed.dir,
        timeout=timeout + 120,
    )
    return call.json()


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
    path = workflow_config_dir(deployed.workflow_dir) / "test_query.txt"
    report = _canyonos_test(recorder, deployed)
    query = path.read_text().strip()
    assert report["results"][0]["query"] == query, report
    problems = _problems(check, report["results"][0]["result"], query=query)
    assert not problems, problems


@pytest.mark.trait("quick")
def test_twenty_queries_at_once_all_finish(recorder, deployed, check):
    timeout = deployed.workflow.timeout
    with ThreadPoolExecutor(max_workers=20) as pool:
        runs = [
            pool.submit(
                result_of, recorder, deployed.endpoint, deployed.query, timeout=timeout
            )
            for _ in range(20)
        ]
        for run in runs:
            request_id, result = run.result()
            problems = _problems(
                check, result, query=deployed.query, request_id=request_id
            )
            assert not problems, problems


def test_status_answers_after_cleanup(recorder, deployed, query_result):
    store = workflow_group_redis(recorder, deployed.dir)
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
    timeout = deployed.workflow.timeout
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


def _every_route(recorder, deployed, request_id, headers) -> list:
    """The query, status and answer routes, each called with `headers`."""
    base = deployed.endpoint.url
    return [
        _post_query(recorder, deployed, headers),
        http(
            recorder, "GET", f"{base}/status/{request_id}", headers=headers, check=False
        ),
        http(
            recorder,
            "POST",
            f"{base}/answer/{request_id}",
            json={"input": "x"},
            headers=headers,
            check=False,
        ),
    ]


def test_every_route_needs_the_api_key(recorder, deployed, query_result):
    for call in _every_route(recorder, deployed, query_result.request_id, {}):
        _assert_refused(call, "auth.missing_key")
        assert call.headers.get("www-authenticate") == "Bearer", call.headers
        assert "result" not in call.json(), call.output


def test_every_route_refuses_a_wrong_key(recorder, deployed, query_result):
    key = recorder.api_key
    for wrong in (f"{key}x", key[:-1], hash_api_key(key)):
        calls = _every_route(recorder, deployed, query_result.request_id, bearer(wrong))
        for call in calls:
            _assert_refused(call, "auth.invalid_key")
            assert "result" not in call.json(), call.output


def test_the_key_is_checked_before_the_body(recorder, deployed):
    call = http(recorder, "POST", _query_url(deployed), json={}, check=False)
    _assert_refused(call, "auth.missing_key")
    wrong = bearer(f"{recorder.api_key}x")
    call = http(
        recorder, "POST", _query_url(deployed), json={}, headers=wrong, check=False
    )
    _assert_refused(call, "auth.invalid_key")


def test_the_bearer_scheme_is_matched_in_any_case(recorder, deployed, query_result):
    url = f"{deployed.endpoint.url}/status/{query_result.request_id}"
    for header in (f"bearer {recorder.api_key}", f"BEARER  {recorder.api_key} "):
        call = http(
            recorder, "GET", url, headers={"Authorization": header}, check=False
        )
        assert call.code == 200, call.output


def test_only_a_bearer_header_carries_the_key(recorder, deployed):
    basic = base64.b64encode(f"e2e:{recorder.api_key}".encode()).decode()
    for header in (recorder.api_key, f"Basic {basic}"):
        call = _post_query(recorder, deployed, {"Authorization": header})
        _assert_refused(call, "auth.missing_key")


def test_the_endpoint_waits_for_the_published_key_hash(recorder, deployed):
    store = workflow_group_redis(recorder, deployed.dir)
    published = store.get(API_KEY_HASH_KEY)
    workflows = json.loads(store.hget(IDENTITY_KEY, "workflows"))
    assert published == hash_api_key(recorder.api_key), published
    assert deployed.workflow_id in workflows, workflows
    try:
        store.delete(API_KEY_HASH_KEY)
        for headers in (deployed.endpoint.headers, {}):
            _assert_refused(
                _post_query(recorder, deployed, headers), "auth.not_ready", 503
            )
    finally:
        store.set(API_KEY_HASH_KEY, published)
    call = _post_query(recorder, deployed, deployed.endpoint.headers)
    assert call.code == 202, call.output


@pytest.mark.trait("quick")
def test_canyonos_test_sends_the_key_and_never_shows_it(recorder, deployed):
    timeout = deployed.workflow.timeout
    call = canyonos(
        recorder,
        ["test", cli_query(deployed), "--timeout", str(timeout)],
        cwd=deployed.dir,
        timeout=timeout + 120,
    )
    assert recorder.api_key not in call.output, call.output
