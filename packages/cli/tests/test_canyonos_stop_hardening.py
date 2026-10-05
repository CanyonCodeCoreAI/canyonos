import subprocess

from canyonos import dashboard_stack, stop as stop_cmd

STOP_WARNING = (
    "Deploy stopped, but the dashboard did not. Run `canyonos quit` to remove it."
)


def _running_deploy(monkeypatch, reported):
    monkeypatch.setattr(
        stop_cmd,
        "require_state",
        lambda: {"container_id": "abcdef123456", "port": 8000},
    )
    monkeypatch.setattr(stop_cmd, "post_clean", lambda _port: None)
    monkeypatch.setattr(stop_cmd.ui, "ok", lambda _message: reported.append("ok"))
    monkeypatch.setattr(
        stop_cmd.ui, "warn", lambda message: reported.append(str(message))
    )


def test_dashboard_stop_failure_is_not_reported_as_success(monkeypatch):
    reported = []
    _running_deploy(monkeypatch, reported)
    monkeypatch.setattr(stop_cmd, "stop_dashboard", lambda: False)

    stop_cmd.run_stop()

    assert reported == [STOP_WARNING]


def test_stop_outside_the_project_warns_while_dashboard_containers_run(
    monkeypatch, tmp_path
):
    reported = []
    _running_deploy(monkeypatch, reported)
    monkeypatch.chdir(tmp_path)
    docker_calls = []

    def docker(argv, **_kwargs):
        docker_calls.append(argv)
        leftover = "9f1c2d3e4b5a\n" if argv[-2:] == ["ps", "-q"] else ""
        return subprocess.CompletedProcess(argv, 0, leftover, "")

    monkeypatch.setattr(dashboard_stack.subprocess, "run", docker)

    stop_cmd.run_stop()

    assert ["docker", "compose", "-p", "canyonos-dashboard", "stop"] in docker_calls
    assert reported == [STOP_WARNING]
