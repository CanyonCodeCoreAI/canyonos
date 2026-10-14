# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Prompt management on a port with prompts.yaml: a new version can be published
and made live through the dashboard API. Runs only for projects with the
`prompts` trait."""

import pytest

pytestmark = pytest.mark.trait("prompts")


def test_prompt_version_goes_live(deployed):
    base = f"/projects/{deployed.project_id}/prompts"
    prompts = deployed.api.get(base).json()
    assert prompts, "the port declares the prompts trait but lists no prompts"
    name = prompts[0]["name"]
    current = deployed.api.get(f"{base}/{name}").json()
    content = current["live"]["content"] + "\n\n(ecosystem check edit)"
    created = deployed.api.post(
        f"{base}/{name}/versions", json={"content": content}
    ).json()
    deployed.api.put(f"{base}/{name}/live", json={"version": created["version"]})
    live = deployed.api.get(f"{base}/{name}").json()["live"]
    assert live["version"] == created["version"], live
    assert live["content"] == content, live
