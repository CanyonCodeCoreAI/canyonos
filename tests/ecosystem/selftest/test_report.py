# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""report.md is built from junit.xml files and traces alone, the same way every time."""

import json
import re
from pathlib import Path

from ..report import render

JUNIT = """<?xml version="1.0" encoding="utf-8"?>
<testsuites><testsuite name="pytest" tests="3" failures="1" errors="0">
<testcase classname="ecosystem.cases.test_1_cli" name="test_validate" time="1.0"/>
<testcase classname="ecosystem.cases.test_3_api" name="test_distribution[latency]" time="2.0">
<failure message="AssertionError: timed out">Traceback...</failure></testcase>
<testcase classname="ecosystem.cases.test_9_teardown" name="test_quit_cleans_up" time="1.0"/>
</testsuite></testsuites>
"""


def _project(root: Path, name: str, junit: str | None = JUNIT) -> Path:
    directory = root / name
    directory.mkdir()
    if junit is not None:
        (directory / "junit.xml").write_text(junit)
    return directory


def test_counts_and_failure_details(tmp_path):
    alpha = _project(tmp_path, "alpha")
    trace = alpha / "traces" / "test_3_api__test_distribution_latency_"
    (trace / "containers").mkdir(parents=True)
    (trace / "calls.jsonl").write_text(
        json.dumps(
            {
                "kind": "http",
                "label": "GET http://127.0.0.1:3000/projects/x/metrics/distribution",
                "input": "",
                "output": '{"buckets": []}',
                "code": 200,
                "seconds": 0.1,
            }
        )
        + "\n"
    )
    (trace / "longrepr.txt").write_text("AssertionError: timed out after 90s")
    (trace / "trace_error.txt").write_text("DoctorFailed: socket closed")
    (trace / "containers" / "canyonos-alpha-global-controller.log").write_text("gc log")
    _project(
        tmp_path,
        "beta",
        junit=JUNIT.replace(
            '<failure message="AssertionError: timed out">Traceback...</failure>', ""
        ),
    )

    text = render(tmp_path, title="Ecosystem check: abc123, 2026-10-14")

    assert text.startswith("# Ecosystem check: abc123, 2026-10-14")
    assert "| alpha | 2 | 1 |" in text
    assert "| beta | 3 | 0 |" in text
    assert "### alpha › test_3_api::test_distribution[latency]" in text
    assert "GET http://127.0.0.1:3000/projects/x/metrics/distribution" in text
    assert "timed out after 90s" in text
    assert "DoctorFailed: socket closed" in text
    assert "canyonos-alpha-global-controller.log" in text
    assert "gc log" in text
    assert text == render(tmp_path, title="Ecosystem check: abc123, 2026-10-14")


def test_project_without_results_is_a_failure(tmp_path):
    _project(tmp_path, "gamma", junit=None)
    text = render(tmp_path, title="t")
    assert "| gamma | 0 | 1 |" in text
    assert "### gamma › no results" in text


def test_setup_error_points_at_the_setup_trace(tmp_path):
    junit = JUNIT.replace(
        '<testcase classname="ecosystem.cases.test_1_cli" name="test_validate" time="1.0"/>',
        '<testcase classname="ecosystem.cases.test_1_cli" name="test_validate" time="1.0">'
        '<error message="failed on setup">deploy failed</error></testcase>',
    )
    delta = _project(tmp_path, "delta", junit=junit)
    setup = delta / "traces" / "setup"
    setup.mkdir(parents=True)
    (setup / "longrepr.txt").write_text("CallFailed: canyonos deploy -> 1")
    text = render(tmp_path, title="t")
    assert "### delta › setup" in text
    assert "test_1_cli::test_validate" in text
    assert "traces/setup/" in text
    assert "canyonos deploy -> 1" in text


def test_setup_trace_is_rendered_once_for_every_case_it_failed(tmp_path):
    junit = re.sub(
        r'(<testcase classname="[^"]+" name="[^"]+" time="[^"]+")/>',
        r'\1><error message="failed on setup">deploy failed</error></testcase>',
        JUNIT,
    )
    epsilon = _project(tmp_path, "epsilon", junit=junit)
    setup = epsilon / "traces" / "setup"
    setup.mkdir(parents=True)
    (setup / "longrepr.txt").write_text("CallFailed: canyonos deploy -> 1")
    text = render(tmp_path, title="t")
    assert text.count("### epsilon › ") == 2
    assert text.count("canyonos deploy -> 1") == 1
    assert "test_1_cli::test_validate" in text
    assert "test_9_teardown::test_quit_cleans_up" in text
    assert "### epsilon › test_3_api::test_distribution[latency]" in text


def test_captured_backticks_do_not_close_the_fence(tmp_path):
    zeta = _project(tmp_path, "zeta")
    trace = zeta / "traces" / "test_3_api__test_distribution_latency_"
    trace.mkdir(parents=True)
    (trace / "longrepr.txt").write_text("answer:\n```python\nprint(1)\n````\nend")
    text = render(tmp_path, title="t")
    assert "`````\nanswer:\n```python\nprint(1)\n````\nend\n`````" in text


def test_container_logs_render_once_per_project(tmp_path):
    junit = JUNIT.replace(
        '<testcase classname="ecosystem.cases.test_1_cli" name="test_validate" time="1.0"/>',
        '<testcase classname="ecosystem.cases.test_1_cli" name="test_validate" time="1.0">'
        '<failure message="AssertionError">x</failure></testcase>',
    )
    eta = _project(tmp_path, "eta", junit=junit)
    for slug, text in (
        ("test_1_cli__test_validate", "validate copy"),
        ("test_3_api__test_distribution_latency_", "distribution copy"),
    ):
        containers = eta / "traces" / slug / "containers"
        containers.mkdir(parents=True)
        (containers / "canyonos-eta-api.log").write_text(text)
        (containers / "canyonos-eta-web.log").write_text("web log")
    (eta / "containers").mkdir()
    (eta / "containers" / "canyonos-eta-api.log").write_text("teardown copy")
    text = render(tmp_path, title="t")
    assert text.count("#### Container logs") == 1
    assert text.count("<summary>canyonos-eta-api.log</summary>") == 1
    assert text.count("<summary>canyonos-eta-web.log</summary>") == 1
    assert "teardown copy" in text
    assert "validate copy" not in text
    assert text.index("#### Container logs") > text.index("test_distribution[latency]")


def test_passing_project_shows_no_container_logs(tmp_path):
    theta = _project(
        tmp_path,
        "theta",
        junit=JUNIT.replace(
            '<failure message="AssertionError: timed out">Traceback...</failure>', ""
        ),
    )
    (theta / "containers").mkdir()
    (theta / "containers" / "canyonos-theta-api.log").write_text("api log")
    assert "Container logs" not in render(tmp_path, title="t")


def test_malformed_junit_fails_only_that_project(tmp_path):
    _project(tmp_path, "iota", junit="<testsuites><testsuite>")
    _project(tmp_path, "kappa")
    text = render(tmp_path, title="t")
    assert "| iota | 0 | 1 |" in text
    assert "### iota › unreadable results" in text
    assert "`junit.xml` could not be parsed" in text
    assert "| kappa | 2 | 1 |" in text
    assert text == render(tmp_path, title="t")


def test_malformed_calls_fail_only_that_call_block(tmp_path):
    lambda_ = _project(tmp_path, "lambda")
    trace = lambda_ / "traces" / "test_3_api__test_distribution_latency_"
    trace.mkdir(parents=True)
    (trace / "calls.jsonl").write_text('{"kind": "http", "lab\n')
    (trace / "longrepr.txt").write_text("AssertionError: timed out after 90s")
    text = render(tmp_path, title="t")
    assert "`calls.jsonl` could not be parsed" in text
    assert "timed out after 90s" in text
