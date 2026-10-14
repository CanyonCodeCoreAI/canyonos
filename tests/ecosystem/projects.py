# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The projects the ecosystem check runs: one directory per project under
tests/ecosystem/projects with its pinned source and its result checker."""

from __future__ import annotations

import importlib.util
from dataclasses import dataclass
from pathlib import Path

import yaml

PROJECTS_DIR = Path(__file__).parent / "projects"


@dataclass(frozen=True)
class Project:
    """One project to check: where to clone it from, what it needs, which trait
    cases apply, and how long its query may take."""

    name: str
    repo: str
    ref: str
    path: str
    secrets: list[str]
    traits: list[str]
    timeout: int
    dir: Path

    @property
    def clone_url(self) -> str:
        """The GitHub HTTPS address the ecosystem check clones the project from."""
        return f"https://github.com/{self.repo}.git"


def list_projects() -> list[str]:
    """Names of every project directory that has a project.yaml, sorted."""
    return sorted(p.parent.name for p in PROJECTS_DIR.glob("*/project.yaml"))


def load_project(name: str) -> Project:
    """Read tests/ecosystem/projects/<name>/project.yaml into a Project; raise
    FileNotFoundError naming the directory when it does not exist."""
    directory = PROJECTS_DIR / name
    config_path = directory / "project.yaml"
    if not config_path.is_file():
        raise FileNotFoundError(f"no project.yaml in tests/ecosystem/projects/{name}")
    with config_path.open() as handle:
        config = yaml.safe_load(handle)
    return Project(
        name=name,
        repo=config["repo"],
        ref=str(config["ref"]),
        path=config["path"],
        secrets=list(config.get("secrets", [])),
        traits=list(config.get("traits", [])),
        timeout=int(config.get("timeout", 900)),
        dir=directory,
    )


def load_check(project: Project):
    """Import the project's check.py, whose `problems(result)` says what is wrong
    with a workflow result, as a module."""
    spec = importlib.util.spec_from_file_location(
        f"ecosystem_check_{project.name.replace('-', '_')}", project.dir / "check.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
