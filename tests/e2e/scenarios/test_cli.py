# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos validate` before anything is deployed: it passes a clean port, refuses a
broken manifest before any image is built, says it checked nothing when there is
no manifest, and runs the same checks inside the core image when the CLI is
installed without CanyonOS Core, as the published one is."""

import shutil

import pytest

from ..harness import REPO_ROOT, canyonos, cli_env, run
from .break_manifest import MODES, break_manifest, rewrite_manifest

CORE_IMAGE_MODE = "rename"


def _validate(recorder, root, cwd, expected_code):
    args = ["validate", *([] if root is None else [str(root)]), "--json"]
    call = canyonos(recorder, args, cwd=cwd, check=False)
    assert call.code == expected_code, call.output
    return call.json()


def _published_cli(recorder, args, cwd):
    """Run `canyonos` from the CLI package alone, built and installed in a throwaway
    environment the way the release installs it, so CanyonOS Core is not importable
    and `canyonos validate` has to run its checks in the core image."""
    argv = [
        "uv",
        "run",
        "--isolated",
        "--no-project",
        "--with",
        str(REPO_ROOT / "packages" / "cli"),
        *args,
    ]
    return run(recorder, argv, cwd=cwd, env=cli_env(), check=False)


def _broken_copy(staged_port, tmp_path, mode):
    broken = tmp_path / "broken" / ".canyon"
    shutil.copytree(staged_port / ".canyon", broken)
    return broken, break_manifest(broken, mode)


def test_validate_passes_a_clean_port(recorder, staged):
    portfolio = staged("portfolio")
    body = _validate(recorder, None, portfolio, 0)
    assert body["errors"] == 0 and body["findings"] == [], body


@pytest.mark.parametrize("mode", sorted(MODES))
def test_validate_rejects_a_broken_manifest(recorder, staged, tmp_path, mode):
    portfolio = staged("portfolio")
    broken, expected = _broken_copy(portfolio, tmp_path, mode)
    findings = _validate(recorder, broken, portfolio, 1)["findings"]
    assert len(findings) == 1, findings
    assert expected in findings[0]["summary"], findings


def test_validate_says_it_checked_nothing_without_a_manifest(recorder, tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    body = _validate(recorder, empty, tmp_path, 2)
    assert body["errors"] is None and body["findings"] == [], body
    assert "config/workflow_config.yaml not found" in body["error"], body


def test_validate_expands_a_variable_from_the_project_env(recorder, staged):
    """Deploy hands the Global Controller the `.env` of the folder canyonos runs
    in, so validate has to expand `${VAR}` from that same file, not from the one
    beside `.canyon/config`."""
    portfolio = staged("portfolio")
    with (portfolio / ".env").open("a") as env:
        env.write("CANYONOS_E2E_SSH_KEY=/tmp/canyonos-e2e-key\n")
    rewrite_manifest(
        portfolio / ".canyon",
        lambda manifest: manifest.update(
            ssh_private_key_path="${CANYONOS_E2E_SSH_KEY}"
        ),
    )
    _validate(recorder, None, portfolio, 0)


def test_validate_runs_in_the_core_image_without_core_installed(
    recorder, images, staged, tmp_path
):
    portfolio = staged("portfolio")
    core = _published_cli(recorder, ["python", "-c", "import canyonos_core"], tmp_path)
    assert core.code != 0 and "No module named 'canyonos_core'" in core.output, (
        core.output
    )
    clean = _published_cli(recorder, ["canyonos", "validate", "--json"], portfolio)
    assert clean.code == 0, clean.output
    assert clean.json()["findings"] == [], clean.stdout
    broken, expected = _broken_copy(portfolio, tmp_path, CORE_IMAGE_MODE)
    call = _published_cli(
        recorder, ["canyonos", "validate", str(broken), "--json"], portfolio
    )
    assert call.code == 1, call.output
    findings = call.json()["findings"]
    assert len(findings) == 1 and expected in findings[0]["summary"], findings
