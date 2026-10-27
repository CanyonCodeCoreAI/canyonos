# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos convert`: where the skill comes from, how the agent is launched, and
what verdict the port it leaves behind gets."""

import shutil
import subprocess
import tarfile
from functools import partial
from pathlib import Path
from typing import Literal

import pytest

from canyonos import convert as convert_cmd
from canyonos import env
from canyonos.validate import UNCHECKED

CODELOAD = "https://codeload.github.com/CanyonCodeCoreAI/canyonos"


@pytest.mark.parametrize(
    "ref",
    ["main", "cli-v0.1.724", "some/feature-branch"],
)
def test_the_tarball_url_is_a_bare_ref(ref):
    """codeload resolves a branch, a tag or a commit from `tar.gz/<ref>`; the
    refs/heads/ form 404s for a tag, which a skill source is allowed to be."""
    assert convert_cmd._tarball_url(ref) == f"{CODELOAD}/tar.gz/{ref}"


@pytest.fixture
def skill_dir(tmp_path):
    source = tmp_path / "converting-to-canyonos"
    source.mkdir()
    (source / "SKILL.md").write_text("---\nname: converting-to-canyonos\n---\n")
    return source


def test_a_local_skill_directory_is_copied_into_place(skill_dir, tmp_path):
    dest = tmp_path / "skills" / "converting-to-canyonos"

    assert convert_cmd._install_skill(str(dest), str(skill_dir)) is True
    assert (dest / "SKILL.md").is_file()
    # Copied, not moved: the checkout it came from is still there.
    assert (skill_dir / "SKILL.md").is_file()


@pytest.mark.parametrize("agent", ["claude", "codex"])
def test_convert_installs_checkout_skill_in_agent_directory(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, agent: str
) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(
        convert_cmd,
        "_install_skill",
        partial(convert_cmd._install_skill, source=env.LOCAL_SKILL_DIR),
    )
    monkeypatch.setattr(convert_cmd, "_launch_agent", lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(convert_cmd, "_report_port", lambda: True)

    assert convert_cmd.run_convert(agent=agent, scope="local", yes=True)
    destination = tmp_path / f".{agent}" / "skills" / "converting-to-canyonos"
    for filename in ("SKILL.md", "prepare.py"):
        assert (destination / filename).read_bytes() == (
            Path(env.LOCAL_SKILL_DIR) / filename
        ).read_bytes()


@pytest.mark.parametrize("transport", ["git", "tarball"])
def test_fetch_installs_skill_from_repository_root(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    transport: Literal["git", "tarball"],
) -> None:
    repository = tmp_path / "repository"
    source = repository / "skills" / "converting-to-canyonos"
    shutil.copytree(env.LOCAL_SKILL_DIR, source)
    (repository / "README.md").write_text("Not part of the skill.\n")
    destination = tmp_path / "installed"

    if transport == "git":
        if shutil.which("git") is None:
            pytest.skip("git is not installed")
        for arguments in (
            ["init", "-b", "main"],
            ["add", "."],
            [
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "Add skill",
            ],
        ):
            subprocess.run(
                ["git", *arguments], cwd=repository, check=True, capture_output=True
            )
        monkeypatch.setattr(convert_cmd, "REPO_URL", repository.as_uri())
        assert convert_cmd._fetch_with_git(str(destination), "main")
    else:
        archive = tmp_path / "repository.tar.gz"
        with tarfile.open(archive, "w:gz") as bundle:
            bundle.add(repository, arcname="canyonos-main")
        monkeypatch.setattr(convert_cmd, "_tarball_url", lambda _ref: archive.as_uri())
        assert convert_cmd._fetch_with_tarball(str(destination), "main")

    assert {path.name for path in destination.iterdir()} == {"SKILL.md", "prepare.py"}
    for filename in ("SKILL.md", "prepare.py"):
        assert (destination / filename).read_bytes() == (source / filename).read_bytes()


def test_a_failed_copy_is_an_install_failure_not_a_traceback(
    monkeypatch, skill_dir, tmp_path
):
    dest = tmp_path / "skills" / "converting-to-canyonos"
    dest.mkdir(parents=True)
    (dest / "SKILL.md").write_text("previous install\n")

    def denied(*_args, **_kwargs):
        raise OSError(13, "Permission denied")

    monkeypatch.setattr(convert_cmd.shutil, "copytree", denied)

    def never(*_args, **_kwargs):
        raise AssertionError("an explicit local source must not fall back to a fetch")

    monkeypatch.setattr(convert_cmd, "FETCH_STRATEGIES", (("git", never),))

    assert convert_cmd._install_skill(str(dest), str(skill_dir)) is False
    # Nothing was torn down on the way out.
    assert (dest / "SKILL.md").read_text() == "previous install\n"


def test_the_production_ref_is_never_read_as_a_directory(monkeypatch, tmp_path):
    """A project with a `main/` directory next to it still gets the ref fetched."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / convert_cmd.SKILL_REF).mkdir()
    fetched = []

    monkeypatch.setattr(
        convert_cmd,
        "FETCH_STRATEGIES",
        (("git", lambda _dest, ref: fetched.append(ref) or True),),
    )
    monkeypatch.setattr(
        convert_cmd.shutil,
        "copytree",
        lambda *_a, **_k: pytest.fail("the ref was read as a path"),
    )

    assert (
        convert_cmd._install_skill(str(tmp_path / "dest"), convert_cmd.SKILL_REF)
        is True
    )
    assert fetched == [convert_cmd.SKILL_REF]


@pytest.fixture
def convertible(monkeypatch):
    """Everything run_convert drives before the agent succeeds."""
    monkeypatch.setattr(convert_cmd, "_install_skill", lambda *_a, **_k: True)
    monkeypatch.setattr(convert_cmd, "_report_port", lambda: True)


@pytest.fixture
def agent_on_path(monkeypatch):
    """The agent CLI resolves; record the argv it would have been run with."""
    monkeypatch.setattr(convert_cmd.shutil, "which", lambda _cli: f"/usr/bin/{_cli}")
    calls = []

    class Completed:
        returncode = 0

    def run(argv, **_kwargs):
        calls.append(argv)
        return Completed()

    monkeypatch.setattr(convert_cmd.subprocess, "run", run)
    return calls


def _set_tty(monkeypatch, attached):
    monkeypatch.setattr(convert_cmd.sys.stdin, "isatty", lambda: attached)
    monkeypatch.setattr(convert_cmd.sys.stdout, "isatty", lambda: attached)


def test_an_attended_launch_passes_no_unattended_flags(monkeypatch, agent_on_path):
    _set_tty(monkeypatch, True)

    assert convert_cmd._launch_agent("claude", "port it", unattended=False) == 0
    assert agent_on_path[0] == ["claude", "port it"]


def test_codex_has_network_in_both_modes(monkeypatch, agent_on_path):
    _set_tty(monkeypatch, True)
    network = ["-c", "sandbox_workspace_write.network_access=true"]

    convert_cmd._launch_agent("codex", "port it", unattended=False)
    convert_cmd._launch_agent("codex", "port it", unattended=True)

    attended, unattended = agent_on_path
    assert attended == ["codex", *network, "port it"]
    assert unattended[:4] == ["codex", "exec", "--sandbox", "workspace-write"]
    assert unattended[4:6] == network


def test_an_unattended_launch_keeps_its_flags_on_a_tty(monkeypatch, agent_on_path):
    _set_tty(monkeypatch, True)

    convert_cmd._launch_agent("claude", "port it", unattended=True)

    argv = agent_on_path[0]
    assert argv[1:-1] == convert_cmd.AGENTS["claude"]["unattended"]
    assert argv[-1].endswith(convert_cmd.UNATTENDED_NOTE)


def test_a_launch_without_a_tty_is_unattended(monkeypatch, agent_on_path):
    _set_tty(monkeypatch, False)

    convert_cmd._launch_agent("claude", "port it", unattended=False)

    argv = agent_on_path[0]
    assert argv[1:-1] == convert_cmd.AGENTS["claude"]["unattended"]
    assert argv[-1].endswith(convert_cmd.UNATTENDED_NOTE)


def test_a_missing_agent_cli_reports_no_status(monkeypatch):
    monkeypatch.setattr(convert_cmd.shutil, "which", lambda _cli: None)

    assert convert_cmd._launch_agent("claude", "port it", unattended=True) is None


def test_yes_runs_the_agent_unattended(monkeypatch, convertible, agent_on_path):
    _set_tty(monkeypatch, True)

    assert convert_cmd.run_convert(yes=True) is True
    assert agent_on_path[0][1:-1] == convert_cmd.AGENTS["claude"]["unattended"]


def test_a_failed_agent_never_consults_an_earlier_port(monkeypatch, convertible):
    monkeypatch.setattr(convert_cmd, "_launch_agent", lambda *_a, **_k: 1)
    monkeypatch.setattr(
        convert_cmd,
        "_report_port",
        lambda: pytest.fail("a dead session is no evidence about .canyon"),
    )

    assert convert_cmd.run_convert(yes=True) is False


def test_a_missing_agent_cli_fails_the_conversion(monkeypatch, convertible):
    monkeypatch.setattr(convert_cmd, "_launch_agent", lambda *_a, **_k: None)

    assert convert_cmd.run_convert(yes=True) is False


def test_a_port_with_no_canyon_fails(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(
        convert_cmd,
        "run_validate",
        lambda *_a, **_k: pytest.fail("nothing to validate without a .canyon"),
    )

    assert convert_cmd._report_port() is False


def test_a_port_is_validated_where_it_was_produced(monkeypatch, tmp_path):
    """The verdict comes from `canyonos validate` over `.canyon`, in this process.

    No file is looked for in the skill directory: the skill ships no validator
    to shell out to, and _report_port is not told where the skill landed.
    """
    monkeypatch.chdir(tmp_path)
    (tmp_path / convert_cmd.CANYON_DIR).mkdir()
    validated = []
    monkeypatch.setattr(
        convert_cmd, "run_validate", lambda root: validated.append(root) or 0
    )

    assert convert_cmd._report_port() is True
    assert validated == [convert_cmd.CANYON_DIR]


@pytest.mark.parametrize(
    ("status", "passed"), [(0, True), (1, False), (UNCHECKED, False)]
)
def test_a_port_takes_its_verdict_from_the_validator(
    monkeypatch, tmp_path, status, passed
):
    monkeypatch.chdir(tmp_path)
    (tmp_path / convert_cmd.CANYON_DIR).mkdir()
    monkeypatch.setattr(convert_cmd, "run_validate", lambda _root: status)

    assert convert_cmd._report_port() is passed


def _flat(capsys):
    return " ".join(capsys.readouterr().out.split())


def test_a_port_with_findings_did_not_pass(monkeypatch, tmp_path, capsys):
    monkeypatch.chdir(tmp_path)
    (tmp_path / convert_cmd.CANYON_DIR).mkdir()
    monkeypatch.setattr(convert_cmd, "run_validate", lambda _root: 1)

    assert convert_cmd._report_port() is False
    assert "did not pass validation" in _flat(capsys)


def test_a_port_nobody_could_check_is_unverified_not_failed(
    monkeypatch, tmp_path, capsys
):
    """No core and no Docker is still a failed conversion, but not a failed port:
    the line must not send the user hunting for findings that were never
    produced."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / convert_cmd.CANYON_DIR).mkdir()
    monkeypatch.setattr(convert_cmd, "run_validate", lambda _root: UNCHECKED)

    assert convert_cmd._report_port() is False
    out = _flat(capsys)
    assert "could not be validated" in out
    assert "did not pass" not in out
