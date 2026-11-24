# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""A deployed endpoint pauses for a person's answer, holds each call to an agent
behind a review gate until a reviewer approves or rejects it, and recovers a failed
result from the dashboard after its Redis result expires."""

from dataclasses import dataclass
from pathlib import Path
import json
import re
import shlex

import pytest
import redis

from ..conftest import DEPLOY_TIMEOUT
from ..harness import (
    answer,
    canyonos,
    canyonos_in_terminal,
    deployed_endpoint,
    docker,
    Endpoint,
    finished,
    http,
    poll,
    workflow_dir,
    workflow_group_redis,
    stage,
    stop_workflow_group,
    submit,
)
from ..workflows import load_workflow

CLEANUP_TIMEOUT = 240
DASHBOARD_DATABASE = "canyonos-dashboard-db"
QUESTION = "What should the workflow remember?"
FAILURE = "the workflow failed after human input"
REVIEWERS = "greeters"
WORKFLOW = f'''\
from agents.hello_agent import HelloAgent


class Workflow:
    def main(self, query: str):
        if query == "fail":
            raise RuntimeError("{FAILURE}")
        if query.startswith("greet "):
            agent = HelloAgent()
            greetings = [agent.hello(name=name) for name in query.split()[1:]]
            return {{"greetings": greetings}}
        if query == "unreviewed":
            try:
                greeting = str(HelloAgent().hello(name="nobody"))
            except Exception as error:
                greeting = str(error)
            return {{"greeting": greeting, "answer": input("{QUESTION}")}}
        answer = input("{QUESTION}")
        return {{"answer": answer}}
'''
# The shortest time a review gate allows, so a review nobody answers ends soon.
REVIEW_TIMEOUT_SECONDS = 60
# How long input() waits for its answer.
QUESTION_TIMEOUT_SECONDS = 3600
# Every call to HelloAgent waits for a reviewer in REVIEWERS; Workflow's do not.
GOVERNANCE = f"""\
agents:
  HelloAgent:
    review:
      reviewers: {REVIEWERS}
      timeout_seconds: {REVIEW_TIMEOUT_SECONDS}
"""
APPROVAL_SCHEMA = {"approve": "bool", "message": "str | None"}


@dataclass(frozen=True)
class HumanInputDeploy:
    directory: Path
    endpoint: Endpoint
    store: redis.Redis


@pytest.fixture(scope="module")
def human_input_deploy(recorder, images, tmp_path_factory):
    """A minimal real workflow whose ordinary input() is handled by CanyonOS."""
    directory = stage(
        recorder,
        load_workflow("helloworld"),
        tmp_path_factory.mktemp("human-input"),
        {},
    )
    folder = workflow_dir(directory)
    (folder / "agents" / "workflow.py").write_text(WORKFLOW)
    (folder / "config" / "governance.yaml").write_text(GOVERNANCE)
    try:
        canyonos(
            recorder, ["deploy", str(folder)], cwd=directory, timeout=DEPLOY_TIMEOUT
        )
        yield HumanInputDeploy(
            directory=directory,
            endpoint=deployed_endpoint(recorder, directory),
            store=workflow_group_redis(recorder, directory),
        )
    finally:
        stop = stop_workflow_group(recorder, directory)
        assert stop is None or stop.code == 0, stop.output[-2000:]


def _waiting_status(recorder, deployment, request_id, count=1):
    """The request's `/status` once it has `count` questions waiting."""
    url = f"{deployment.endpoint.url}/status/{request_id}"

    def waiting():
        call = http(
            recorder, "GET", url, headers=deployment.endpoint.headers, check=False
        )
        if call.code != 200:
            return None
        status = call.json()
        if status["status"] != "input_required":
            return None
        return status if len(status["questions"]) == count else None

    return poll(
        waiting, timeout=120, interval=1, what=f"{count} question(s) of {request_id}"
    )


def _listed_questions(recorder, deployment, request_id):
    """The questions `GET /questions` lists for `request_id`, as it lists them."""
    call = http(
        recorder,
        "GET",
        f"{deployment.endpoint.url}/questions",
        headers=deployment.endpoint.headers,
    )
    return [
        question
        for question in call.json()["questions"]
        if question["request_id"] == request_id
    ]


def _assert_review(question, name):
    """`question`, one entry of `questions`, asks a reviewer in REVIEWERS to approve
    HelloAgent.hello for `name`."""
    assert question["input_schema"] == APPROVAL_SCHEMA, question
    assert isinstance(question["id"], str) and question["id"], question
    assert isinstance(question["asked_at"], int), question
    review = question["question"]
    assert review["kind"] == "review", review
    assert review["agent"].endswith(".HelloAgent"), review
    assert review["method"] == "hello", review
    assert review["arguments"] == {"name": name}, review
    assert review["reviewers"] == REVIEWERS, review


def _assert_expires(question, timeout_seconds):
    """`question`, one entry of `questions`, stops being waited for `timeout_seconds`
    after it was asked."""
    expected = question["asked_at"] + timeout_seconds * 1000
    assert abs(question["expires_at"] - expected) <= 1000, question


def _hello_failure(store, request_id):
    """The error name and text HelloAgent's call of `request_id` failed with."""
    for future_id in store.smembers(f"request:{request_id}:futures"):
        record = store.hgetall(f"future:{future_id}")
        if record.get("service", "").endswith(".HelloAgent"):
            return record.get("error_name"), record.get("error")
    return None


def _dashboard_failure(recorder, request_id):
    """Read the actual dashboard database through its private container network."""
    query = (
        "select coalesce(json_agg(json_build_array(status_code, status_message)), "
        "'[]'::json)::text from otel_spans"
        f" where trace_id = '{request_id}' and parent_span_id is null"
    )
    call = docker(
        recorder,
        [
            "exec",
            DASHBOARD_DATABASE,
            "psql",
            "-U",
            "canyonos",
            "-d",
            "canyonos",
            "-tA",
            "-c",
            query,
        ],
        check=False,
    )
    if call.code != 0:
        return None
    rows = json.loads(call.output)
    return tuple(rows[0]) if rows else None


def test_workflow_pauses_for_an_answer_and_resumes(recorder, human_input_deploy):
    request_id = submit(recorder, human_input_deploy.endpoint, "pause")
    waiting = _waiting_status(recorder, human_input_deploy, request_id)
    [listed] = waiting.pop("questions")
    assert waiting == {
        "request_id": request_id,
        "status": "input_required",
        "question": {"question": QUESTION, "input_schema": {"input": "str"}},
    }, waiting
    assert listed["question"] == QUESTION, listed
    assert listed["input_schema"] == {"input": "str"}, listed
    _assert_expires(listed, QUESTION_TIMEOUT_SECONDS)
    assert _listed_questions(recorder, human_input_deploy, request_id) == [
        {"request_id": request_id, **listed}
    ]

    answered = answer(
        recorder, human_input_deploy.endpoint, request_id, {"input": "remember this"}
    )
    assert answered.json() == {"request_id": request_id}, answered.output

    status = finished(recorder, human_input_deploy.endpoint, request_id, timeout=120)
    assert status == {
        "request_id": request_id,
        "status": "done",
        "result": {"answer": "remember this"},
    }, status

    repeated = answer(
        recorder,
        human_input_deploy.endpoint,
        request_id,
        {"input": "too late"},
        check=False,
    )
    assert repeated.code == 409, repeated.output
    assert repeated.json() == {
        "error": f"Request {request_id} is not waiting for input"
    }, repeated.output


def test_a_reviewer_approves_a_gated_call_and_it_runs(recorder, human_input_deploy):
    endpoint = human_input_deploy.endpoint
    request_id = submit(recorder, endpoint, "greet Ada")
    waiting = _waiting_status(recorder, human_input_deploy, request_id)
    [question] = waiting["questions"]
    _assert_review(question, "Ada")
    _assert_expires(question, REVIEW_TIMEOUT_SECONDS)
    assert waiting["question"] == {
        "question": question["question"],
        "input_schema": APPROVAL_SCHEMA,
    }, waiting
    assert _listed_questions(recorder, human_input_deploy, request_id) == [
        {"request_id": request_id, **question}
    ]

    approved = answer(
        recorder, endpoint, request_id, {"approve": True}, question=question["id"]
    )
    assert approved.code == 202, approved.output

    status = finished(recorder, endpoint, request_id, timeout=120)
    assert status["status"] == "done", status
    assert status["result"] == {"greetings": ["Hello, Ada! I'm the HelloAgent!"]}
    assert _listed_questions(recorder, human_input_deploy, request_id) == []


def test_a_reviewer_rejects_a_gated_call_after_a_malformed_answer(
    recorder, human_input_deploy
):
    endpoint = human_input_deploy.endpoint
    request_id = submit(recorder, endpoint, "greet Mallory")
    [first] = _waiting_status(recorder, human_input_deploy, request_id)["questions"]
    _assert_review(first, "Mallory")

    # An answer without a true or false `approve` is asked again, as a new question.
    malformed = answer(recorder, endpoint, request_id, {"approve": "maybe"})
    assert malformed.code == 202, malformed.output
    [again] = poll(
        lambda: [
            question
            for question in _listed_questions(recorder, human_input_deploy, request_id)
            if question["id"] != first["id"]
        ],
        timeout=120,
        interval=1,
        what=f"the review of {request_id} asked again",
    )
    _assert_review(again, "Mallory")

    rejected = answer(
        recorder,
        endpoint,
        request_id,
        {"approve": False, "message": "not today"},
        question=again["id"],
    )
    assert rejected.code == 202, rejected.output

    status = finished(recorder, endpoint, request_id, timeout=120)
    assert status["status"] == "error", status
    assert "Rejected by a reviewer: not today" in status["error"], status
    assert _hello_failure(human_input_deploy.store, request_id) == (
        "review.rejected",
        "Rejected by a reviewer: not today",
    )


def test_an_unanswered_review_times_out_and_is_no_longer_listed(
    recorder, human_input_deploy
):
    endpoint = human_input_deploy.endpoint
    request_id = submit(recorder, endpoint, "unreviewed")
    [review] = _waiting_status(recorder, human_input_deploy, request_id)["questions"]
    _assert_review(review, "nobody")
    _assert_expires(review, REVIEW_TIMEOUT_SECONDS)
    assert _listed_questions(recorder, human_input_deploy, request_id) == [
        {"request_id": request_id, **review}
    ]

    # Nobody answers: once its time is up the gated call fails, and the workflow
    # catches that and asks its own question, so the request goes on past the review.
    def only_the_workflows_question():
        listed = _listed_questions(recorder, human_input_deploy, request_id)
        return listed if [q["question"] for q in listed] == [QUESTION] else None

    [question] = poll(
        only_the_workflows_question,
        timeout=REVIEW_TIMEOUT_SECONDS + 120,
        interval=2,
        what=f"the review of {request_id} to time out",
    )
    [waiting] = _waiting_status(recorder, human_input_deploy, request_id)["questions"]
    assert {"request_id": request_id, **waiting} == question, waiting
    timed_out = (
        f"No reviewer in {REVIEWERS} answered within {REVIEW_TIMEOUT_SECONDS} seconds"
    )
    assert _hello_failure(human_input_deploy.store, request_id) == (
        "review.timed_out",
        timed_out,
    )

    answered = answer(
        recorder, endpoint, request_id, {"input": "late"}, question=question["id"]
    )
    assert answered.code == 202, answered.output
    status = finished(recorder, endpoint, request_id, timeout=120)
    assert status["status"] == "done", status
    assert timed_out in status["result"]["greeting"], status
    assert status["result"]["answer"] == "late", status


def test_two_waiting_reviews_are_answered_by_their_ids(recorder, human_input_deploy):
    endpoint = human_input_deploy.endpoint
    request_id = submit(recorder, endpoint, "greet one two")
    waiting = _waiting_status(recorder, human_input_deploy, request_id, count=2)
    questions = waiting["questions"]
    assert questions[0]["asked_at"] <= questions[1]["asked_at"], questions
    assert waiting["question"]["question"] == questions[0]["question"], waiting
    by_name = {
        question["question"]["arguments"]["name"]: question for question in questions
    }
    _assert_review(by_name["one"], "one")
    _assert_review(by_name["two"], "two")
    assert _listed_questions(recorder, human_input_deploy, request_id) == [
        {"request_id": request_id, **question} for question in questions
    ]

    # The newest one first, by its id; answering it twice finds it gone.
    newest = questions[1]
    first = answer(
        recorder, endpoint, request_id, {"approve": True}, question=newest["id"]
    )
    assert first.code == 202, first.output
    repeated = answer(
        recorder,
        endpoint,
        request_id,
        {"approve": True},
        question=newest["id"],
        check=False,
    )
    assert repeated.code == 409, repeated.output
    assert repeated.json() == {
        "error": f"Question {newest['id']} of request {request_id} is not waiting "
        "for an answer"
    }, repeated.output

    [left] = _waiting_status(recorder, human_input_deploy, request_id)["questions"]
    assert left == questions[0], left
    second = answer(
        recorder, endpoint, request_id, {"approve": True}, question=left["id"]
    )
    assert second.code == 202, second.output

    status = finished(recorder, endpoint, request_id, timeout=120)
    assert status["result"] == {
        "greetings": [
            "Hello, one! I'm the HelloAgent!",
            "Hello, two! I'm the HelloAgent!",
        ]
    }, status


def test_chat_finds_adds_switches_and_deletes_workflows_and_answers_questions(
    recorder, human_input_deploy
):
    endpoint = human_input_deploy.endpoint
    url = f"{endpoint.url}/{endpoint.route}"
    body = shlex.quote(json.dumps({endpoint.argument: "your query"}))
    curl = (
        f'curl -X POST {url} -H "Authorization: Bearer {endpoint.api_key}" '
        f'-H "Content-Type: application/json" -d {body}'
    )
    box = f"{endpoint.argument} (str)"
    outside = human_input_deploy.directory.parent

    def chat(cwd, answers, shown=None):
        call = canyonos_in_terminal(
            recorder, ["chat"], cwd=cwd, answers=answers, timeout=180
        )
        assert call.code == 0, call.output
        if shown is not None:
            assert shown in call.output, call.output
            assert re.search(r"request [0-9a-f]{32} · ", call.output), call.output

    # In the workflow group's folder its workflow is there without a curl; the answer is
    # fixed with the arrow, Delete and Home keys.
    chat(
        human_input_deploy.directory,
        [
            (box, "pause\r"),
            ("the question above", "emember thxis\x1b[D\x1b[D\x1b[D\x1b[3~\x1b[Hr\r"),
            (box, "/quit\r"),
        ],
        "answer  remember this",
    )
    # Its result comes back from /recent, without typing the request ID.
    chat(
        human_input_deploy.directory,
        [
            (box, "/rec\t\r"),
            ("Show the result of", "\r"),
            # Typed only once the next box is up: keys sent while the result is
            # still being shown are lost.
            ("answer  remember this", ""),
            (box, "/quit\r"),
        ],
    )
    # Elsewhere it is deleted, refused from a curl that isn't a workflow's, added back
    # from its own, and answered with a pasted newline; then deleted for good.
    chat(
        outside,
        [
            ("/ commands", "/sw\t\r"),
            ("Switch to", "d"),
            ("/ commands", "/add curl -X POST http://127.0.0.1:9/x -d '{}'\r"),
            ("not a workflow's curl command", f"/add {curl}\r"),
            (box, "pause\r"),
            ("the question above", "and\rthis café\r"),
            (box, "/quit\r"),
        ],
        # Text with a line break shows as Markdown, which joins the lines.
        "and this café",
    )
    chat(
        outside,
        [("/ commands", "/switch\r"), ("Switch to", "d"), ("/ commands", "/quit\r")],
    )
    assert url not in (Path.home() / ".canyonos" / "chat.json").read_text()


def test_failed_status_recovers_from_its_dashboard_span(recorder, human_input_deploy):
    request_id = submit(recorder, human_input_deploy.endpoint, "fail")
    live = finished(recorder, human_input_deploy.endpoint, request_id, timeout=120)
    assert live["status"] == "error", live
    assert FAILURE in (live.get("error") or ""), live

    dashboard = poll(
        lambda: _dashboard_failure(recorder, request_id),
        timeout=120,
        interval=2,
        what=f"failed root span for {request_id}",
    )
    status_code, status_message = dashboard
    assert status_code == "STATUS_CODE_ERROR", dashboard
    assert status_message == live["error"], dashboard

    request = f"request:{request_id}"

    def cleaned_up():
        live_keys = human_input_deploy.store.exists(
            f"{request}:futures", f"{request}:future"
        )
        return not live_keys and human_input_deploy.store.exists(f"{request}:result")

    poll(
        cleaned_up,
        timeout=CLEANUP_TIMEOUT,
        what=f"cleanup to move {request} to {request}:result",
    )
    assert human_input_deploy.store.delete(f"{request}:result") == 1

    recovered = http(
        recorder,
        "GET",
        f"{human_input_deploy.endpoint.url}/status/{request_id}",
        headers=human_input_deploy.endpoint.headers,
    ).json()
    assert recovered == {
        "request_id": request_id,
        "status": "error",
        "error": status_message,
    }, recovered
