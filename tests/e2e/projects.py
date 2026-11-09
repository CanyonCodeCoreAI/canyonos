# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The projects the E2E check deploys: one directory per project under
tests/e2e/projects with its project.yaml and its result checker.

Run as a script, it prints the JSON list of project names a CI event runs:
`python tests/e2e/projects.py pr` leaves out the projects marked `release_only`,
`python tests/e2e/projects.py release` lists them all, and any other words are
taken as project names, each of which must exist."""

from __future__ import annotations

import importlib.util
import json
import sys
from dataclasses import dataclass
from pathlib import Path

import yaml

PROJECTS_DIR = Path(__file__).parent / "projects"
REPO_ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Git:
    """A project cloned from GitHub: `repo` at the full commit `ref`, from `path`."""

    repo: str
    ref: str
    path: str

    @property
    def clone_url(self) -> str:
        """The GitHub HTTPS address the project is cloned from."""
        return f"https://github.com/{self.repo}.git"


@dataclass(frozen=True)
class Project:
    """One project to check: where its code comes from, what it needs, which trait
    cases apply, and how long its query may take.

    `source` is a folder of this repository or a `Git` checkout. `port`, when set, is
    a committed `.canyon` folder copied over the source; `overlay` maps a path in the
    staged project to a file in the project directory that replaces it."""

    name: str
    dir: Path
    source: Path | Git
    port: Path | None
    overlay: dict[str, Path]
    query: object | None
    cli_query: str | None
    calls: dict[str, int] | None
    secrets: list[str]
    env: dict[str, str]
    traits: list[str]
    timeout: int
    release_only: bool


def list_projects() -> list[str]:
    """Names of every project directory that has a project.yaml, sorted."""
    return sorted(p.parent.name for p in PROJECTS_DIR.glob("*/project.yaml"))


def _source(config: dict) -> Path | Git:
    source = config["source"]
    if isinstance(source, str):
        return REPO_ROOT / source
    return Git(repo=source["repo"], ref=str(source["ref"]), path=source["path"])


def load_project(name: str) -> Project:
    """Read tests/e2e/projects/<name>/project.yaml into a Project; raise
    FileNotFoundError naming the directory when it does not exist."""
    directory = PROJECTS_DIR / name
    config_path = directory / "project.yaml"
    if not config_path.is_file():
        raise FileNotFoundError(f"no project.yaml in tests/e2e/projects/{name}")
    config = yaml.safe_load(config_path.read_text())
    port = config.get("port")
    return Project(
        name=name,
        dir=directory,
        source=_source(config),
        port=directory / port if port else None,
        overlay={
            target: directory / file
            for target, file in (config.get("overlay") or {}).items()
        },
        query=config.get("query"),
        cli_query=config.get("cli_query"),
        calls=config.get("calls"),
        secrets=list(config.get("secrets") or []),
        env={key: str(value) for key, value in (config.get("env") or {}).items()},
        traits=list(config.get("traits") or []),
        timeout=int(config.get("timeout", 900)),
        release_only=bool(config.get("release_only", False)),
    )


def load_check(project: Project):
    """Import the project's check.py, whose `problems(result)` says what is wrong
    with a workflow result, as a module."""
    spec = importlib.util.spec_from_file_location(
        f"e2e_check_{project.name.replace('-', '_')}", project.dir / "check.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def selected(words: list[str]) -> list[str]:
    """The project names a run asked for: `pr`, `release`, or explicit names."""
    names = list_projects()
    if words in ([], ["pr"]):
        return [n for n in names if not load_project(n).release_only]
    if words == ["release"]:
        return names
    unknown = [w for w in words if w not in names]
    if unknown:
        raise SystemExit(f"unknown project: {', '.join(unknown)}; known: {names}")
    return list(dict.fromkeys(words))


if __name__ == "__main__":
    print(json.dumps(selected(" ".join(sys.argv[1:]).split())))
