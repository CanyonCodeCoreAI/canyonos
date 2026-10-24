# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import subprocess

import pytest

from canyonos import clean


def completed(argv, returncode=0, stdout="", stderr=""):
    return subprocess.CompletedProcess(argv, returncode, stdout, stderr)


@pytest.fixture(autouse=True)
def isolated_global_skill_dirs(monkeypatch, tmp_path):
    """Point the global skill installs at tmp_path, never the real home directory."""
    agents = {
        name: {
            **spec,
            "skill_dirs": {
                **spec["skill_dirs"],
                "global": str(tmp_path / "home" / spec["skill_dirs"]["local"]),
            },
        }
        for name, spec in clean.convert.AGENTS.items()
    }
    monkeypatch.setattr(clean.convert, "AGENTS", agents)


def in_project(monkeypatch, tmp_path, name, agents=("Workflow", "CVPilotAgent")):
    """Make `tmp_path/<name>` a project whose `global_controller.yaml` declares
    `agents`, and run from it."""
    root = tmp_path / name
    (root / "config").mkdir(parents=True)
    (root / "config" / "global_controller.yaml").write_text(
        "agents:\n" + "".join(f"  - name: {agent}\n" for agent in agents)
    )
    monkeypatch.chdir(root)
    return root


def test_docker_unavailable_warns_and_does_not_crash(monkeypatch, tmp_path):
    warnings = []
    in_project(monkeypatch, tmp_path, "portfolio")
    monkeypatch.setattr(
        clean.subprocess,
        "run",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(FileNotFoundError("docker")),
    )
    monkeypatch.setattr(clean.ui, "warn", warnings.append)

    clean.run_clean()

    assert any("Docker" in warning for warning in warnings)


def test_canyon_directory_is_removed(monkeypatch, tmp_path):
    canyon_dir = tmp_path / ".canyon"
    canyon_dir.mkdir()
    (canyon_dir / "artifact").write_text("built")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(
        clean.subprocess,
        "run",
        lambda argv, **_: completed(argv),
    )

    clean.run_clean()

    assert not canyon_dir.exists()


def test_project_skills_are_removed_and_global_skills_kept(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(clean.subprocess, "run", lambda argv, **_: completed(argv))
    skill_dirs = {
        scope: [
            tmp_path / spec["skill_dirs"][scope]
            for spec in clean.convert.AGENTS.values()
        ]
        for scope in clean.convert.SCOPES
    }
    for skill_dir in skill_dirs["local"] + skill_dirs["global"]:
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text("skill")

    clean.run_clean()

    assert not any(skill_dir.exists() for skill_dir in skill_dirs["local"])
    assert all(skill_dir.exists() for skill_dir in skill_dirs["global"])


def test_emptied_skill_folders_are_removed_and_user_skills_kept(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(clean.subprocess, "run", lambda argv, **_: completed(argv))
    claude_skill, codex_skill = (
        tmp_path / spec["skill_dirs"]["local"] for spec in clean.convert.AGENTS.values()
    )
    user_skill = claude_skill.parent / "my-own-skill"
    for skill_dir in (claude_skill, codex_skill, user_skill):
        skill_dir.mkdir(parents=True)

    clean.run_clean()

    assert user_skill.exists()
    assert not claude_skill.exists()
    assert not (tmp_path / ".codex").exists()


def test_symlinked_skill_is_unlinked_and_its_target_kept(monkeypatch, tmp_path):
    target = tmp_path / "checkout" / "skill"
    target.mkdir(parents=True)
    (target / "SKILL.md").write_text("skill")
    skill_link = tmp_path / clean.convert.AGENTS["claude"]["skill_dirs"]["local"]
    skill_link.parent.mkdir(parents=True)
    skill_link.symlink_to(target, target_is_directory=True)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(clean.subprocess, "run", lambda argv, **_: completed(argv))

    clean.run_clean()

    assert not skill_link.is_symlink()
    assert (target / "SKILL.md").exists()


def test_unreadable_env_warns_and_images_are_still_cleaned(monkeypatch, tmp_path):
    calls = []
    warnings = []

    def fake_run(argv, **_):
        calls.append(argv)
        return completed(argv)

    def unreadable(env_path):
        raise PermissionError(f"Permission denied: '{env_path}'")

    in_project(monkeypatch, tmp_path, "portfolio")
    monkeypatch.setattr(clean.subprocess, "run", fake_run)
    monkeypatch.setattr(clean.ui, "warn", warnings.append)
    monkeypatch.setattr(clean.dashboard_stack, "remove_project_env_keys", unreadable)

    clean.run_clean()

    assert any(".env" in warning for warning in warnings)
    assert calls[0][:2] == ["docker", "images"]


def test_image_removal_failure_warns_without_forcing(monkeypatch, tmp_path):
    calls = []
    warnings = []

    def fake_run(argv, **_):
        calls.append(argv)
        if argv[:2] == ["docker", "images"]:
            return completed(argv, stdout="image-in-use\n")
        return completed(
            argv, returncode=1, stderr="image is being used by running container"
        )

    in_project(monkeypatch, tmp_path, "portfolio")
    monkeypatch.setattr(clean.subprocess, "run", fake_run)
    monkeypatch.setattr(clean.ui, "warn", warnings.append)

    clean.run_clean()

    assert calls[1] == ["docker", "image", "rm", "image-in-use"]
    assert "-f" not in calls[1]
    assert "image is being used by running container" in warnings[-1]
