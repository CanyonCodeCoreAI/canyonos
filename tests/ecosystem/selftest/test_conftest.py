# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Trait selection, the endpoint line read after a deploy, which runs need a
project, and which runs get failure traces and from which call they start."""

from pathlib import Path
from types import SimpleNamespace

import pytest

from ..conftest import (
    CALL_START_KEY,
    CASES_DIR,
    PROJECT_KEY,
    endpoint_from_output,
    names_cases,
    pytest_runtest_setup,
    select_by_traits,
    writes_traces,
)
from ..harness import Call, Recorder


def _item(trait=None):
    marker = None if trait is None else SimpleNamespace(args=(trait,))
    return SimpleNamespace(
        name=trait or "baseline", get_closest_marker=lambda _: marker
    )


def test_baseline_cases_always_run():
    keep, drop = select_by_traits([_item()], traits=set())
    assert [item.name for item in keep] == ["baseline"]
    assert drop == []


def test_trait_cases_run_only_with_the_trait():
    items = [_item(), _item("prompts"), _item("docker-in-docker")]
    keep, drop = select_by_traits(items, traits={"prompts"})
    assert [item.name for item in keep] == ["baseline", "prompts"]
    assert [item.name for item in drop] == ["docker-in-docker"]


def test_endpoint_line_is_found_before_trailing_stderr():
    output = (
        "Installed 3 packages in 5ms\n"
        '{"api_port": 8080, "method": "run", "argument": "query"}\n'
        "Resolved 120 packages in 1ms\n"
        "UserWarning: {not json\n"
    )
    assert endpoint_from_output(output) == {
        "api_port": 8080,
        "method": "run",
        "argument": "query",
    }


def test_missing_endpoint_line_fails_with_the_output():
    with pytest.raises(AssertionError, match="Installed 3 packages"):
        endpoint_from_output("Installed 3 packages in 5ms\n")


def _traced_item(stash):
    return SimpleNamespace(
        config=SimpleNamespace(stash=stash),
        session=SimpleNamespace(_ecosystem_artifacts=Path("artifacts")),
    )


def test_selftest_runs_write_no_traces():
    assert not writes_traces(_traced_item({}))


def test_project_runs_write_traces():
    assert writes_traces(_traced_item({PROJECT_KEY: object()}))


def _config(*args):
    return SimpleNamespace(
        args=list(args), invocation_params=SimpleNamespace(dir=CASES_DIR.parents[2])
    )


def test_only_named_cases_need_a_project():
    assert names_cases(_config("tests/ecosystem/cases"))
    assert names_cases(_config("tests/ecosystem/cases/test_3_api.py::test_health"))
    assert not names_cases(_config("tests"))
    assert not names_cases(_config("tests/ecosystem/selftest"))


def test_case_calls_start_before_its_session_fixtures():
    recorder = Recorder()
    recorder.record(Call("cli", "git clone", "", "", 0, 0.1))
    item = SimpleNamespace(
        session=SimpleNamespace(_ecosystem_recorder=recorder), stash=pytest.Stash()
    )
    pytest_runtest_setup(item)
    assert item.stash[CALL_START_KEY] == 1
