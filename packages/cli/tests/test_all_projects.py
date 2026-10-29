# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import os
import subprocess
import sys

import pytest

import cli
from canyonos import clean, docker_cmd, project, stop as stop_cmd
from canyonos.gc import GCError

CONTAINERS = "\n".join(
    [
        "a1 canyonos-portfolio",
        "b2 canyonos-gone",
        "c3 canyonos-dashboard",
        "d4 canyonos-cli-usage",
    ]
)
VOLUMES = (
    "canyonos-portfolio-workspace canyonos-portfolio\n"
    "canyonos-cli-usage-dynamodb-data canyonos-cli-usage"
)
NETWORKS = "canyonos-portfolio canyonos-portfolio\ncanyonos-dashboard_default canyonos-dashboard"
IMAGES = "canyonos-core:dev\ncanyonos-portfolio-myagent:latest\ncanyonos-gone-pg:<none>"
ALL_CONTAINERS = "\n".join(
    [
        "canyonos-control-plane\t\tcanyonos",
        "canyonos-workflow-0\t\t",
        "canyonos-portfolio-redis-localhost\tcanyonos-portfolio\t",
    ]
)


class FakeDocker:
    """Answers each Docker listing a teardown of every project makes and records every
    call."""

    def __init__(self, fail=None):
        self.calls = []
        self.fail = fail

    def __call__(self, argv, **_kwargs):
        self.calls.append(argv)
        if self.fail and argv[: len(self.fail)] == self.fail:
            return subprocess.CompletedProcess(argv, 1, "", "permission denied")
        command = argv[1:3]
        if argv[1] == "inspect":
            return subprocess.CompletedProcess(argv, 1, "", "No such object")
        if argv[1] == "port":
            out = "127.0.0.1:8003\n"
        elif argv[1] == "ps" and "-q" in argv:
            out = "gc1\n"
        elif argv[1] == "ps" and "--filter" in argv:
            out = CONTAINERS
        elif argv[1] == "ps":
            out = ALL_CONTAINERS
        elif command == ["volume", "ls"]:
            out = VOLUMES
        elif command == ["network", "ls"]:
            out = NETWORKS
        elif argv[1] == "images":
            out = IMAGES
        else:
            out = ""
        return subprocess.CompletedProcess(argv, 0, out, "")

    def removals(self):
        return [call for call in self.calls if "rm" in call[:3]]


@pytest.fixture
def docker(monkeypatch):
    fake = FakeDocker()
    monkeypatch.setattr(docker_cmd.subprocess, "run", fake)
    monkeypatch.setattr(stop_cmd, "stop_dashboard", lambda: True)
    monkeypatch.setattr(stop_cmd, "teardown_dashboard", lambda: True)
    monkeypatch.setattr(stop_cmd, "post_clean", lambda _port: None)
    _project_records("portfolio", "gone")
    return fake


def _project_records(*names):
    for name in names:
        folder = os.path.join(project.projects_dir(), name)
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, "state.json"), "w", encoding="utf-8") as f:
            f.write(f'{{"container_id": "gc-{name}", "port": 8000}}')
        with open(
            os.path.join(folder, "sync-manifest.json"), "w", encoding="utf-8"
        ) as f:
            f.write("{}")


def test_every_projects_resources_are_removed_by_label(docker):
    assert stop_cmd.stop_all() is True

    assert docker.removals() == [
        ["docker", "rm", "-f", "-v", "a1", "b2"],
        ["docker", "volume", "rm", "canyonos-portfolio-workspace"],
        ["docker", "network", "rm", "canyonos-portfolio", "canyonos-local"],
    ]


def test_each_running_deploy_is_cleaned_through_its_own_port_first(monkeypatch, docker):
    cleaned = []
    monkeypatch.setattr(
        stop_cmd, "post_clean", lambda port: cleaned.append((port, len(docker.calls)))
    )

    stop_cmd.stop_all()

    [(port, calls_before)] = cleaned
    assert port == "8003"
    assert ["docker", "port", "gc1", "8000/tcp"] in docker.calls[:calls_before]
    assert not any("rm" in call[:3] for call in docker.calls[:calls_before])


def test_a_controller_with_no_deploy_running_is_not_a_failure(monkeypatch, docker):
    monkeypatch.setattr(
        stop_cmd,
        "post_clean",
        lambda _port: (_ for _ in ()).throw(GCError("no deploy", code=409)),
    )

    assert stop_cmd.stop_all() is True


def test_a_controller_that_wont_clean_is_reported_and_still_removed(
    monkeypatch, docker
):
    monkeypatch.setattr(
        stop_cmd,
        "post_clean",
        lambda _port: (_ for _ in ()).throw(GCError("stuck", code=500)),
    )

    assert stop_cmd.stop_all() is False
    assert ["docker", "rm", "-f", "-v", "a1", "b2"] in docker.removals()


def test_the_dashboard_is_stopped_first_and_left_on_no_projects_network(
    monkeypatch, docker
):
    calls_before = []
    monkeypatch.setattr(
        stop_cmd,
        "stop_dashboard",
        lambda: calls_before.append(len(docker.calls)) or True,
    )

    stop_cmd.stop_all()

    assert calls_before == [0]
    disconnect = ["docker", "network", "disconnect", "--force", "canyonos-portfolio"]
    assert [*disconnect, "canyonos-dashboard-api-1"] in docker.calls


def test_state_files_go_and_other_records_stay(docker):
    _project_records("portfolio", "gone")

    stop_cmd.stop_all()

    for name in ("portfolio", "gone"):
        folder = os.path.join(project.projects_dir(), name)
        assert os.listdir(folder) == ["sync-manifest.json"]


def test_a_failure_keeps_the_state_files_for_a_retry(monkeypatch, docker, capsys):
    _project_records("portfolio")
    docker.fail = ["docker", "volume", "rm"]

    assert stop_cmd.stop_all() is False

    assert os.path.exists(
        os.path.join(project.projects_dir(), "portfolio", "state.json")
    )
    captured = capsys.readouterr()
    assert "permission denied" in captured.err
    assert "canyonos stop --all" in captured.out


def test_unlabelled_containers_are_named_but_kind_nodes_are_not(docker, capsys):
    stop_cmd.stop_all()

    output = " ".join(capsys.readouterr().out.split())
    assert "docker rm -f canyonos-workflow-0`" in output
    assert "canyonos-control-plane" not in output


def test_stop_all_reaches_run_stop(monkeypatch):
    seen = {}
    monkeypatch.setattr(cli, "run_stop", lambda **kwargs: seen.update(kwargs))
    monkeypatch.setattr(sys, "argv", ["canyonos", "stop", "--all"])

    with pytest.raises(SystemExit):
        cli._run_command()

    assert seen == {"all_projects": True}


def test_clean_all_and_yes_reach_run_clean(monkeypatch):
    seen = {}
    monkeypatch.setattr(cli, "run_clean", lambda **kwargs: seen.update(kwargs))
    monkeypatch.setattr(sys, "argv", ["canyonos", "clean", "--all", "-y"])

    with pytest.raises(SystemExit):
        cli._run_command()

    assert seen == {"all_projects": True, "yes": True}


def test_clean_all_removes_images_by_name_then_the_canyonos_folder(docker):
    _project_records("portfolio", "gone")

    assert stop_cmd.stop_all(remove_everything=True) is True

    [listing] = [call for call in docker.calls if call[1] == "images"]
    references = [arg for arg in listing if arg.startswith("reference=")]
    assert "reference=ghcr.io/canyoncodecoreai/canyonos-core" in references
    assert {"reference=canyonos-portfolio-*", "reference=canyonos-gone-*"} <= set(
        references
    )
    # By name and tag, never by ID, so a registry copy of the same image keeps it.
    assert [
        "docker",
        "image",
        "rm",
        "canyonos-core:dev",
        "canyonos-portfolio-myagent:latest",
    ] in docker.calls
    assert not os.path.exists(os.path.dirname(project.projects_dir()))


def test_clean_all_keeps_images_and_records_when_the_teardown_failed(docker):
    _project_records("portfolio")
    docker.fail = ["docker", "volume", "rm"]

    assert stop_cmd.stop_all(remove_everything=True) is False

    assert not any(call[1] in ("images", "image") for call in docker.calls)
    assert os.path.isdir(project.projects_dir())


@pytest.mark.parametrize(
    ("interactive", "answer"), [(True, False), (True, None), (False, True)]
)
def test_clean_all_removes_nothing_without_a_yes(monkeypatch, interactive, answer):
    monkeypatch.setattr(stop_cmd, "is_interactive", lambda: interactive)
    monkeypatch.setattr(stop_cmd, "select_menu", lambda *_a, **_k: answer)
    monkeypatch.setattr(
        clean, "stop_all", lambda **_k: pytest.fail("nothing should be removed")
    )

    assert clean.run_clean(all_projects=True) is False


@pytest.mark.parametrize(("yes", "answer"), [(False, True), (True, None)])
def test_clean_all_runs_after_a_yes_or_with_yes(monkeypatch, yes, answer):
    seen = {}
    monkeypatch.setattr(stop_cmd, "is_interactive", lambda: True)
    monkeypatch.setattr(stop_cmd, "select_menu", lambda *_a, **_k: answer)
    monkeypatch.setattr(clean, "stop_all", lambda **kwargs: seen.update(kwargs) or True)

    assert clean.run_clean(all_projects=True, yes=yes) is True
    assert seen == {"remove_everything": True}


@pytest.mark.parametrize(
    ("remove_everything", "expected"), [(False, "stop"), (True, "teardown")]
)
def test_stop_all_keeps_the_dashboard_and_clean_all_removes_it(
    monkeypatch, docker, remove_everything, expected
):
    seen = []
    monkeypatch.setattr(stop_cmd, "stop_dashboard", lambda: seen.append("stop") or True)
    monkeypatch.setattr(
        stop_cmd, "teardown_dashboard", lambda: seen.append("teardown") or True
    )

    stop_cmd.stop_all(remove_everything=remove_everything)

    assert seen == [expected]
