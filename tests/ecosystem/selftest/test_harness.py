# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The recorder keeps what a failing case needs: command, input, output, exit code;
a clone token stays out of it."""

import base64
import json
import os
import sys

import pytest

from ..harness import CallFailed, Recorder, case_slug, git_auth_env, poll, run


def test_run_records_a_failing_command_and_raises():
    recorder = Recorder()
    with pytest.raises(CallFailed) as failure:
        run(
            recorder,
            [sys.executable, "-c", "import sys; print('out'); sys.exit(3)"],
            cwd=".",
        )
    call = failure.value.call
    assert call.kind == "cli"
    assert call.code == 3
    assert "out" in call.output
    assert recorder.calls == [call]


def test_run_without_check_returns_the_call():
    recorder = Recorder()
    call = run(
        recorder, [sys.executable, "-c", "raise SystemExit(1)"], cwd=".", check=False
    )
    assert call.code == 1


def test_dump_writes_json_lines(tmp_path):
    recorder = Recorder()
    run(recorder, [sys.executable, "-c", "print('a')"], cwd=".", stdin="ignored")
    path = tmp_path / "calls.jsonl"
    recorder.dump(path)
    lines = [json.loads(line) for line in path.read_text().splitlines()]
    assert lines[0]["input"] == "ignored"
    assert lines[0]["output"].strip() == "a"


def test_long_output_is_kept_whole_and_clipped_only_in_the_trace():
    recorder = Recorder()
    script = "import json; print(json.dumps({'text': 'x' * 50_000}))"
    call = run(recorder, [sys.executable, "-c", script], cwd=".")
    assert len(call.json()["text"]) == 50_000
    recorded = call.as_dict()["output"]
    assert "characters cut" in recorded
    assert len(recorded) < len(call.output)


def test_case_slug_is_filesystem_safe():
    assert case_slug("test_3_api", "test_distribution[tokens_per_request]") == (
        "test_3_api__test_distribution_tokens_per_request_"
    )


def test_poll_times_out_with_the_reason():
    with pytest.raises(AssertionError, match="waiting for nothing"):
        poll(lambda: None, timeout=0.2, interval=0.05, what="nothing")


TOKEN = "ghs_secretvalue123"


@pytest.mark.parametrize("token", [None, ""])
def test_no_token_only_disables_the_prompt(token):
    assert git_auth_env(token) == {"GIT_TERMINAL_PROMPT": "0"}


def test_token_becomes_a_basic_auth_header():
    env = git_auth_env(TOKEN)
    encoded = base64.b64encode(f"x-access-token:{TOKEN}".encode()).decode()
    assert env == {
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
        "GIT_CONFIG_VALUE_0": f"AUTHORIZATION: basic {encoded}",
    }
    assert not any(TOKEN in value for value in env.values())


def test_token_in_the_environment_is_never_recorded():
    recorder = Recorder()
    script = "import os; print(os.environ['GIT_CONFIG_COUNT'])"
    run(
        recorder,
        [sys.executable, "-c", script],
        cwd=".",
        env={**os.environ, **git_auth_env(TOKEN)},
    )
    call = recorder.calls[0]
    assert call.output.strip() == "1"
    assert TOKEN not in json.dumps(call.as_dict())
