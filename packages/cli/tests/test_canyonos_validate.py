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


@pytest.fixture(autouse=True)
def in_a_project(monkeypatch, tmp_path):
    """Run from a project that holds an (empty) `.car`."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".car").mkdir(exist_ok=True)


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
    os.makedirs("port/.car")

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


def test_a_missing_car_is_refused_before_anything_runs(in_process, capsys):
    seen = in_process([])

    assert validate_cmd.run_validate("missing/.car") == 1
    assert "missing/.car is not a directory" in flat(capsys)
    assert seen == {}


def test_a_missing_car_is_not_mounted_into_docker(docker, capsys):
    """`docker run -v` would create the path, root-owned on Linux."""
    calls = docker(json.dumps({"errors": 0, "findings": []}))

    assert validate_cmd.run_validate("missing/.car") == 1
    assert "argv" not in calls
    assert not os.path.exists("missing")


def test_a_config_outside_the_artifact_is_refused(in_process, capsys):
    in_process([])

    assert validate_cmd.run_validate(".car", config="../config/other.yaml") == 1
    assert "outside .car" in flat(capsys)


def test_a_config_written_as_a_path_into_the_artifact_is_accepted(in_process, tmp_path):
    seen = in_process([])
    root = tmp_path / ".car"

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


def test_the_container_gets_the_artifact_read_only_as_its_workdir(docker, tmp_path):
    calls = docker(json.dumps({"errors": 0, "findings": []}))
    root = tmp_path / ".car"

    assert validate_cmd.run_validate(str(root)) == 0
    assert calls["argv"] == [
        "docker",
        "run",
        "--rm",
        "--name",
        calls["argv"][4],
        "-v",
        f"{root}:/workspace:ro",
        "-w",
        "/workspace",
        "--entrypoint",
        "python",
        env.core_image,
        "-m",
        "canyonos_core.validate",
        ".",
        "--json",
    ]


def test_the_image_entrypoint_is_replaced_by_the_validator(docker, tmp_path):
    """The core image's ENTRYPOINT is the server; left in place it would take
    `python -m canyonos_core.validate` as its own arguments and never exit."""
    calls = docker(json.dumps({"errors": 0, "findings": []}))
    root = tmp_path / ".car"

    validate_cmd.run_validate(str(root))

    argv = calls["argv"]
    image = argv.index(env.core_image)
    assert argv[argv.index("--entrypoint") + 1] == "python"
    assert argv.index("--entrypoint") < image
    assert argv[image + 1 : image + 3] == ["-m", "canyonos_core.validate"]


def test_a_config_is_passed_through_to_the_container(docker, tmp_path):
    calls = docker(json.dumps({"errors": 0, "findings": []}))
    root = tmp_path / ".car"

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


def test_the_container_is_named_after_this_run(docker):
    calls = docker(json.dumps({"errors": 0, "findings": []}))

    validate_cmd.run_validate(".car")
    first = calls["argv"][calls["argv"].index("--name") + 1]
    validate_cmd.run_validate(".car")
    second = calls["argv"][calls["argv"].index("--name") + 1]

    assert first.startswith("canyonos-validate-")
    assert first != second


def test_a_container_that_never_finishes_is_removed_and_reported(
    monkeypatch, docker, capsys
):
    """A timeout kills the docker client, not the container it started."""
    docker("")
    argvs = []

    class _Removed:
        returncode = 0
        stdout = stderr = ""

    def run(argv, **kwargs):
        argvs.append(argv)
        if argv[:2] == ["docker", "run"]:
            raise validate_cmd.subprocess.TimeoutExpired(argv, kwargs["timeout"])
        return _Removed()

    monkeypatch.setattr(validate_cmd.subprocess, "run", run)

    assert validate_cmd.run_validate(".car", as_json=True) == 1
    payload = json.loads(capsys.readouterr().out)

    name = argvs[0][argvs[0].index("--name") + 1]
    assert argvs[1] == ["docker", "rm", "-f", name]
    assert "did not finish within 600s" in payload["error"]


def test_a_reply_missing_a_finding_field_is_a_failure(docker, capsys):
    docker(json.dumps({"findings": [{"code": "CAR-SCHEMA", "path": "x"}]}))

    assert validate_cmd.run_validate(".car") == 1
    assert "returned no findings" in flat(capsys)


def test_a_finding_field_of_the_wrong_type_is_a_failure(docker, capsys):
    reply = dict(finding(), mechanism=None)
    docker(json.dumps({"findings": [reply]}))

    assert validate_cmd.run_validate(".car") == 1
    assert "returned no findings" in flat(capsys)


def test_json_mode_reports_a_failure_as_json(docker, capsys, tmp_path):
    docker("", returncode=125, stderr="Cannot connect to the Docker daemon")
    root = tmp_path / ".car"

    assert validate_cmd.run_validate(str(root), as_json=True) == 1
    payload = json.loads(capsys.readouterr().out)

    # The keys a successful run prints, so `errors` is null rather than absent.
    assert payload["artifact_root"] == str(root)
    assert payload["errors"] is None
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
