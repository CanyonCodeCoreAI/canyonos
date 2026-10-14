# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Build report.md for an ecosystem run from each project's junit.xml and the
traces its failing cases wrote. Standard library only, so the report job can run
it before anything else is installed, and the same inputs always give the same
text.

Usage: report.py <artifacts-dir> <out.md> --title "<heading>"
"""

from __future__ import annotations

import argparse
import json
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

LONGREPR_LINES = 40
OUTPUT_CHARACTERS = 4000
INPUT_CHARACTERS = 2000


@dataclass(frozen=True)
class Case:
    """One testcase from junit.xml, with the outcome the report needs."""

    module: str
    name: str
    failed: bool
    setup_error: bool
    message: str

    @property
    def slug(self) -> str:
        """The trace directory name, the same rule as `harness.case_slug`."""
        return re.sub(r"[^A-Za-z0-9_-]", "_", f"{self.module}__{self.name}")


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def _cases(junit: Path) -> list[Case]:
    cases = []
    for testcase in ET.parse(junit).getroot().iter("testcase"):
        if testcase.find("skipped") is not None:
            continue
        failure = testcase.find("failure")
        error = testcase.find("error")
        problem = failure if failure is not None else error
        cases.append(
            Case(
                module=testcase.get("classname", "").rsplit(".", 1)[-1],
                name=testcase.get("name", ""),
                failed=problem is not None,
                setup_error=error is not None
                and "setup" in (error.get("message") or ""),
                message=(problem.get("message") or "") if problem is not None else "",
            )
        )
    return cases


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
    lines = [f"- Trace: artifact `ecosystem-{project}`, `traces/{trace.name}/`"]
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
    """One section for the shared setup trace, naming every case it failed."""
    lines = [f"### {project} › setup", "", f"- Failed in setup: {len(cases)} cases"]
    lines += [f"  - {case.module}::{case.name}" for case in cases]
    return lines + _trace_lines(project, trace)


def _trace_for(project_dir: Path, case: Case) -> Path | None:
    candidates = ("setup", case.slug) if case.setup_error else (case.slug,)
    for candidate in candidates:
        path = project_dir / "traces" / candidate
        if path.is_dir():
            return path
    return None


def render(artifacts: Path, title: str) -> str:
    """The Markdown report for every project directory under `artifacts`."""
    rows, failures = [], []
    for project_dir in sorted(p for p in artifacts.iterdir() if p.is_dir()):
        project = project_dir.name
        junit = project_dir / "junit.xml"
        if not junit.is_file():
            rows.append((project, 0, 1))
            failures += [
                f"### {project} › no results",
                "",
                "- the job ended before pytest wrote junit.xml",
                "",
            ]
            continue
        try:
            cases = _cases(junit)
        except ET.ParseError as error:
            rows.append((project, 0, 1))
            failures += [
                f"### {project} › unreadable results",
                "",
                f"- `junit.xml` could not be parsed: {error}",
                "",
            ]
            continue
        failed = [case for case in cases if case.failed]
        rows.append((project, len(cases) - len(failed), len(failed)))
        setup_cases = []
        for case in failed:
            trace = _trace_for(project_dir, case)
            if trace is not None and trace.name == "setup":
                setup_cases.append(case)
                continue
            failures += _failure_section(project, case, trace)
            failures.append("")
        if setup_cases:
            setup_trace = project_dir / "traces" / "setup"
            failures += _setup_section(project, setup_cases, setup_trace)
            failures.append("")
        if failed:
            failures += _container_logs(project_dir)
    lines = [f"# {title}", "", "| Project | Passed | Failed |", "|---|---|---|"]
    lines += [f"| {name} | {passed} | {failed} |" for name, passed, failed in rows]
    lines.append("")
    if failures:
        lines += ["## Failures", "", *failures]
    else:
        lines.append("No failures.")
    return "\n".join(lines).rstrip() + "\n"


def main() -> None:
    """Write the report to the output path and echo it to stdout."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifacts", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--title", required=True)
    args = parser.parse_args()
    text = render(args.artifacts, args.title)
    args.out.write_text(text, encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
