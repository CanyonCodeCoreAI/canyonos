# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Build report.md for an E2E run from each project's junit.xml, the cases it
collected (collected.json) and the traces its failing cases wrote. A case counts
as passed only when junit.xml has it with no failure, error or skip; a collected
case junit.xml lacks, as a run cut short leaves it, counts as not run, and so does
every case of an expected project with no junit.xml. Standard library only, so the
report job can run it before anything else is installed, and the same inputs
always give the same text.

Usage: report.py <artifacts-dir> <out.md> --title "<heading>" [--expect NAME...]
"""

from __future__ import annotations

import argparse
import json
import re
import xml.etree.ElementTree as ET
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

LONGREPR_LINES = 40
OUTPUT_CHARACTERS = 4000
INPUT_CHARACTERS = 2000
COLLECTED_FILE = "collected.json"


@dataclass(frozen=True)
class Case:
    """One testcase from junit.xml, with the outcome the report needs."""

    classname: str
    name: str
    failed: bool
    skipped: bool
    setup_error: bool
    message: str

    @property
    def module(self) -> str:
        """The test module's name, the last part of the classname."""
        return self.classname.rsplit(".", 1)[-1]

    @property
    def slug(self) -> str:
        """The trace directory name, the same rule as `harness.case_slug`."""
        return re.sub(r"[^A-Za-z0-9_-]", "_", f"{self.module}__{self.name}")


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def _cases(junit: Path) -> tuple[list[Case], int]:
    """The named testcases in `junit`, and how many have no name: the case an
    interrupt stopped is written as a bare `<testcase/>`."""
    cases, nameless = [], 0
    for testcase in ET.parse(junit).getroot().iter("testcase"):
        if not testcase.get("name"):
            nameless += 1
            continue
        failure = testcase.find("failure")
        error = testcase.find("error")
        problem = failure if failure is not None else error
        cases.append(
            Case(
                classname=testcase.get("classname", ""),
                name=testcase.get("name", ""),
                failed=problem is not None,
                skipped=problem is None and testcase.find("skipped") is not None,
                setup_error=error is not None
                and "setup" in (error.get("message") or ""),
                message=(problem.get("message") or "") if problem is not None else "",
            )
        )
    return cases, nameless


def _collected(project_dir: Path) -> list[tuple[str, str]] | None:
    """The (classname, name) of every case the run collected, or None when the
    run never got that far or the file is unreadable."""
    try:
        cases = json.loads(_read(project_dir / COLLECTED_FILE))
        return [(case["classname"], case["name"]) for case in cases]
    except (OSError, ValueError, KeyError, TypeError):
        return None


def _details(summary: str, body: str) -> str:
    longest_run = max((len(run) for run in re.findall(r"`+", body)), default=0)
    fence = "`" * max(3, longest_run + 1)
    return (
        f"<details><summary>{summary}</summary>\n\n"
        f"{fence}\n{body}\n{fence}\n\n</details>"
    )


def _tail(text: str, limit: int) -> str:
    return text if len(text) <= limit else "..." + text[-limit:]


def _last_call_lines(calls_path: Path) -> list[str]:
    try:
        calls = [json.loads(line) for line in _read(calls_path).splitlines() if line]
    except json.JSONDecodeError as error:
        return [f"- `{calls_path.name}` could not be parsed: {error}"]
    if not calls:
        return []
    last = calls[-1]
    lines = [
        f"- Last call: `{last['label']}`",
        f"- Exit code or status: {last['code']}",
    ]
    if last["input"]:
        lines.append(_details("Input", _tail(last["input"], INPUT_CHARACTERS)))
    lines.append(_details("Output", _tail(last["output"], OUTPUT_CHARACTERS)))
    return lines


def _trace_lines(project: str, trace: Path) -> list[str]:
    lines = [f"- Trace: artifact `e2e-{project}`, `traces/{trace.name}/`"]
    calls_path = trace / "calls.jsonl"
    if calls_path.is_file():
        lines += _last_call_lines(calls_path)
    longrepr = trace / "longrepr.txt"
    if longrepr.is_file():
        excerpt = "\n".join(_read(longrepr).splitlines()[-LONGREPR_LINES:])
        lines.append(_details("Failure", excerpt))
    for name, summary in (
        ("doctor.txt", "canyonos doctor"),
        ("trace_error.txt", "Trace collection error"),
    ):
        path = trace / name
        if path.is_file():
            lines.append(_details(summary, _tail(_read(path), OUTPUT_CHARACTERS)))
    return lines


def _container_logs(project_dir: Path) -> list[str]:
    """One section with each container's log once: the copy saved at teardown when
    there is one, otherwise the first trace's copy in name order."""
    directories = [
        project_dir / "containers",
        *sorted((project_dir / "traces").glob("*/containers")),
    ]
    logs: dict[str, Path] = {}
    for directory in directories:
        for log in sorted(directory.glob("*.log")):
            logs.setdefault(log.name, log)
    if not logs:
        return []
    lines = ["#### Container logs", ""]
    for name in sorted(logs):
        lines += [_details(name, _tail(_read(logs[name]), OUTPUT_CHARACTERS)), ""]
    return lines


def _failure_section(project: str, case: Case, trace: Path | None) -> list[str]:
    lines = [f"### {project} › {case.module}::{case.name}", ""]
    if trace is None:
        lines.append(f"- {case.message or 'failed'}; no trace was written")
        return lines
    return lines + _trace_lines(project, trace)


def _setup_section(project: str, cases: list[Case], trace: Path) -> list[str]:
    """One section for a setup trace, naming every case its setup error failed."""
    lines = [f"### {project} › setup", "", f"- Failed in setup: {len(cases)} cases"]
    lines += [f"  - {case.module}::{case.name}" for case in cases]
    return lines + _trace_lines(project, trace)


def _trace_for(project_dir: Path, case: Case) -> Path | None:
    """The trace a failed case wrote: setup__<case> for a setup error, following
    its same_as.txt to the first case's trace when there is one, else <case>."""
    traces = project_dir / "traces"
    if not case.setup_error:
        path = traces / case.slug
        return path if path.is_dir() else None
    path = traces / f"setup__{case.slug}"
    same_as = path / "same_as.txt"
    if same_as.is_file():
        path = traces / _read(same_as).strip()
    return path if path.is_dir() else None


def _not_run_section(project: str, names: list[str], reason: str) -> list[str]:
    lines = [f"### {project} › not run", "", f"- {reason}"]
    return lines + [f"  - {name}" for name in names] + [""]


def _project(project_dir: Path) -> tuple[tuple, list[str]]:
    """The table row and the failure sections for one project's artifacts."""
    project = project_dir.name
    collected = _collected(project_dir)
    junit = project_dir / "junit.xml"
    if not junit.is_file():
        reason = "the job ended before pytest wrote junit.xml"
        if collected is None:
            return (project, 0, 0, "all", 0), [
                f"### {project} › no results",
                "",
                f"- {reason}",
                "",
            ]
        names = [
            f"{classname.rsplit('.', 1)[-1]}::{name}" for classname, name in collected
        ]
        return (project, 0, 0, len(names), 0), _not_run_section(project, names, reason)
    try:
        cases, nameless = _cases(junit)
    except ET.ParseError as error:
        return (project, 0, 0, "all", 0), [
            f"### {project} › unreadable results",
            "",
            f"- `junit.xml` could not be parsed: {error}",
            "",
        ]
    failed = [case for case in cases if case.failed]
    skipped = [case for case in cases if case.skipped]
    passed = len(cases) - len(failed) - len(skipped)
    seen = {(case.classname, case.name) for case in cases}
    missing = [key for key in (collected or []) if key not in seen]
    not_run = len(missing) if collected is not None else nameless
    sections: list[str] = []
    setup_cases: dict[Path, list[Case]] = {}
    for case in failed:
        trace = _trace_for(project_dir, case)
        if trace is not None and trace.name.startswith("setup__"):
            setup_cases.setdefault(trace, []).append(case)
            continue
        sections += _failure_section(project, case, trace)
        sections.append("")
    for trace, cases_of_trace in setup_cases.items():
        sections += _setup_section(project, cases_of_trace, trace)
        sections.append("")
    if missing:
        names = [
            f"{classname.rsplit('.', 1)[-1]}::{name}" for classname, name in missing
        ]
        sections += _not_run_section(
            project, names, "the run ended before these cases finished"
        )
    elif nameless:
        sections += _not_run_section(
            project, [], "the run was interrupted during a case junit.xml does not name"
        )
    if failed:
        sections += _container_logs(project_dir)
    return (project, passed, len(failed), not_run, len(skipped)), sections


def render(artifacts: Path, title: str, expected: Sequence[str] = ()) -> str:
    """The Markdown report for every project directory under `artifacts` and every
    `expected` project, which fails when it has no directory at all."""
    present = sorted(p.name for p in artifacts.iterdir() if p.is_dir())
    rows, failures = [], []
    for project in sorted({*present, *expected}):
        if project not in present:
            rows.append((project, 0, 0, "all", 0))
            failures += [
                f"### {project} › no results",
                "",
                "- no artifact was uploaded: the job ended before pytest wrote anything",
                "",
            ]
            continue
        row, sections = _project(artifacts / project)
        rows.append(row)
        failures += sections
    lines = [
        f"# {title}",
        "",
        "| Project | Passed | Failed | Not run | Skipped |",
        "|---|---|---|---|---|",
    ]
    lines += ["| " + " | ".join(str(value) for value in row) + " |" for row in rows]
    lines.append("")
    if failures:
        lines += ["## Failures", "", *failures]
    elif rows:
        lines.append("No failures.")
    else:
        lines.append("No results were found.")
    return "\n".join(lines).rstrip() + "\n"


def main() -> None:
    """Write the report to the output path and echo it to stdout."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifacts", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--title", required=True)
    parser.add_argument("--expect", nargs="*", default=[], metavar="NAME")
    args = parser.parse_args()
    text = render(args.artifacts, args.title, args.expect)
    args.out.write_text(text, encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
