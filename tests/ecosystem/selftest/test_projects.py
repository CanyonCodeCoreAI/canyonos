# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Every project definition under tests/ecosystem/projects loads and is complete."""

import re

import pytest

from ..projects import list_projects, load_check, load_project


@pytest.mark.parametrize("name", list_projects())
def test_project_definition_is_complete(name):
    project = load_project(name)
    assert project.name == name
    assert re.fullmatch(r"[0-9a-f]{40}", project.ref), "ref must be a full commit SHA"
    assert project.repo.count("/") == 1, "repo is owner/name"
    assert project.path
    assert project.secrets, "every port needs at least one LLM key"
    assert project.timeout > 0
    assert all(re.fullmatch(r"[a-z0-9-]+", trait) for trait in project.traits)
    check = load_check(project)
    assert callable(check.problems)


def test_unknown_project_names_the_directory():
    with pytest.raises(FileNotFoundError, match="tests/ecosystem/projects/nope"):
        load_project("nope")
