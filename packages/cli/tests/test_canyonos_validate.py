import importlib.util
import json
import os
import pathlib
import sys

import pytest

from canyonos import env, ui
from canyonos import validate as validate_cmd


def finding(code="CAR-ADAPTER-ASYNC"):
    return {
        "code": code,
        "path": "app/agents/echo_agent.py",
        "line": 12,
        "summary": "`EchoAgent.echo` is `async def`",
        "mechanism": "The executor calls method(**args) with no await.",
    }


def flat(capsys):
    """Console output as one line: rich wraps at the terminal width."""
    return " ".join(capsys.readouterr().out.split())


@pytest.fixture(autouse=True)
def loud():
    """Every test starts with output enabled; `--json` runs flip it and restore it."""
    ui.set_quiet(False)
    yield
    ui.set_quiet(False)


@pytest.fixture
def in_process(monkeypatch):
    """Core importable here: `run_validate` gets whatever this hands back."""

    def install(findings):
        seen = {}

        def validate_car(artifact_root, config_path=None):
            seen.update(artifact_root=artifact_root, config_path=config_path)
            return [_Finding(f) for f in findings]

        monkeypatch.setattr(validate_cmd, "_import_validate_car", lambda: validate_car)
        return seen

    return install


class _Finding:
    """Stands in for core's Finding, which the CLI only ever `_asdict()`s."""

    def __init__(self, fields):
        self.fields = fields

    def _asdict(self):
        return dict(self.fields)


@pytest.fixture
def no_core(monkeypatch):
    monkeypatch.setattr(validate_cmd, "_import_validate_car", lambda: None)


# ------------------------------------------------------------------ #
#  In-process path                                                    #
# ------------------------------------------------------------------ #


def test_a_clean_car_passes(in_process, capsys):
    in_process([])

    assert validate_cmd.run_validate(".car") == 0
    assert "clean" in flat(capsys)


def test_the_artifact_and_config_reach_the_validator(in_process):
    seen = in_process([])

    validate_cmd.run_validate("port/.car", config="config/other.yaml")

    assert seen == {"artifact_root": "port/.car", "config_path": "config/other.yaml"}


def test_an_error_is_rendered_as_a_block_and_fails(in_process, capsys):
    in_process([finding()])

    assert validate_cmd.run_validate(".car") == 1
    out = flat(capsys)
    assert "CAR-ADAPTER-ASYNC" in out
    assert "app/agents/echo_agent.py:12" in out
    assert "`EchoAgent.echo` is `async def`" in out
    assert "no await" in out
    assert "1 error(s)." in out


def test_json_mode_prints_one_object_and_nothing_else(in_process, capsys):
    in_process([finding(), finding(code="CAR-FLAT-COLLISION")])

    assert validate_cmd.run_validate(".car", as_json=True) == 1
    payload = json.loads(capsys.readouterr().out)

    assert payload["errors"] == 2
    assert [f["code"] for f in payload["findings"]] == [
        "CAR-ADAPTER-ASYNC",
        "CAR-FLAT-COLLISION",
    ]


def test_a_config_outside_the_artifact_is_refused(in_process, capsys):
    in_process([])

    assert validate_cmd.run_validate(".car", config="../config/other.yaml") == 1
    assert "outside .car" in flat(capsys)


def test_a_config_written_as_a_path_into_the_artifact_is_accepted(in_process, tmp_path):
    seen = in_process([])
    root = tmp_path / ".car"
    root.mkdir()

    validate_cmd.run_validate(str(root), config=str(root / "config" / "other.yaml"))

    assert seen["config_path"] == os.path.join("config", "other.yaml")


# ------------------------------------------------------------------ #
#  Docker fallback                                                    #
# ------------------------------------------------------------------ #


@pytest.fixture
def docker(monkeypatch, no_core):
    """A local Docker that answers with whatever the test hands back."""
    calls = {}

    monkeypatch.setattr(validate_cmd.shutil, "which", lambda _name: "/usr/bin/docker")
    monkeypatch.setattr(
        validate_cmd, "active_docker_socket", lambda: "/var/run/docker.sock"
    )

    def install(stdout, returncode=0, stderr=""):
        class _Result:
            pass

        result = _Result()
        result.stdout = stdout
        result.stderr = stderr
        result.returncode = returncode

        def run(argv, **_kwargs):
            calls["argv"] = argv
            return result

        monkeypatch.setattr(validate_cmd.subprocess, "run", run)
        return calls

    return install


def test_the_container_gets_the_project_read_only_and_the_artifact_by_name(
    docker, tmp_path
):
    calls = docker(json.dumps({"errors": 0, "findings": []}))
    root = tmp_path / ".car"
    root.mkdir()

    assert validate_cmd.run_validate(str(root)) == 0
    assert calls["argv"] == [
        "docker",
        "run",
        "--rm",
        "-v",
        f"{root}:/workspace:ro",
        "-w",
        "/workspace",
        env.core_image,
        "python",
        "-m",
        "canyonos_core.validate",
        ".",
        "--json",
    ]


def test_a_config_is_passed_through_to_the_container(docker, tmp_path):
    calls = docker(json.dumps({"errors": 0, "findings": []}))
    root = tmp_path / ".car"
    root.mkdir()

    validate_cmd.run_validate(str(root), config="config/other.yaml")

    assert calls["argv"][-3:] == ["--config", "config/other.yaml", "--json"]


def test_findings_from_the_container_are_rendered(docker, capsys):
    docker(json.dumps({"errors": 1, "findings": [finding()]}))

    assert validate_cmd.run_validate(".car") == 1
    assert "CAR-ADAPTER-ASYNC" in flat(capsys)


def test_a_container_that_says_nothing_is_a_failure(docker, capsys):
    docker("", returncode=125, stderr="Unable to find image 'canyonos-core:dev'")

    assert validate_cmd.run_validate(".car") == 1
    assert "Unable to find image" in flat(capsys)


def test_a_docker_that_is_not_on_a_local_socket_says_so(monkeypatch, docker, capsys):
    docker("")
    monkeypatch.setattr(validate_cmd, "active_docker_socket", lambda: None)

    assert validate_cmd.run_validate(".car") == 1
    assert "not reachable over a local socket" in flat(capsys)


def test_neither_core_nor_docker_is_one_line(monkeypatch, no_core, capsys):
    monkeypatch.setattr(validate_cmd.shutil, "which", lambda _name: None)

    assert validate_cmd.run_validate(".car") == 1
    assert "neither is available" in flat(capsys)


def test_a_reply_missing_a_finding_field_is_a_failure(docker, capsys):
    docker(json.dumps({"findings": [{"code": "CAR-SCHEMA", "path": "x"}]}))

    assert validate_cmd.run_validate(".car") == 1
    assert "returned no findings" in flat(capsys)


def test_json_mode_reports_a_failure_as_json(docker, capsys):
    docker("", returncode=125, stderr="Cannot connect to the Docker daemon")

    assert validate_cmd.run_validate(".car", as_json=True) == 1
    payload = json.loads(capsys.readouterr().out)

    assert payload["findings"] == []
    assert "Cannot connect to the Docker daemon" in payload["error"]


# ------------------------------------------------------------------ #
#  Registration                                                       #
# ------------------------------------------------------------------ #


def test_the_command_is_on_the_help_screen():
    from utils.help_screen import DESCRIPTIONS

    assert (
        DESCRIPTIONS["validate"] == "Check a ported .car against the CanyonOS contract"
    )


def _entry_point():
    """`packages/cli/cli.py`, loaded by path: `cli` is an ambiguous module name
    across this repo, and the core package owns one too."""
    path = pathlib.Path(__file__).resolve().parents[1] / "cli.py"
    spec = importlib.util.spec_from_file_location("canyonos_entry_point", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_cli_dispatches_to_run_validate(monkeypatch):
    cli = _entry_point()

    seen = {}
    monkeypatch.setattr(
        cli,
        "run_validate",
        lambda root, config, as_json: (
            seen.update(root=root, config=config, as_json=as_json) or 0
        ),
    )
    monkeypatch.setattr(sys, "argv", ["canyonos", "validate", "port/.car", "--json"])

    with pytest.raises(SystemExit) as exit_info:
        cli.main()

    assert exit_info.value.code == 0
    assert seen == {"root": "port/.car", "config": None, "as_json": True}
