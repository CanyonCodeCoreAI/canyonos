# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import json
import os
import subprocess
import sys
import textwrap
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

import cli
from canyonos import env, upgrade

POLICY = {"latest": "0.1.734", "supported": ["0.1.734", "0.1.733", "0.1.732"]}
CLI_DIR = Path(__file__).resolve().parents[1]


def _flat(text):
    """`text` with Rich's line wrapping undone, so a message can be matched whole."""
    return " ".join(text.split())


class _PolicyServer:
    """A stand-in for the public `main`: answers with `body` and `status` after
    `delay` seconds, and counts the requests it gets."""

    def __init__(self):
        self.body, self.status, self.delay, self.requests = POLICY, 200, 0, 0
        server = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                server.requests += 1
                time.sleep(server.delay)
                payload = (
                    server.body
                    if isinstance(server.body, bytes)
                    else json.dumps(server.body).encode()
                )
                self.send_response(server.status)
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        self._httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self._httpd.server_port}/supported-versions.json"
        threading.Thread(target=self._httpd.serve_forever, daemon=True).start()

    def close(self):
        self._httpd.shutdown()
        self._httpd.server_close()


@pytest.fixture
def server(monkeypatch):
    policy_server = _PolicyServer()
    monkeypatch.setattr(upgrade, "POLICY_URL", policy_server.url)
    yield policy_server
    policy_server.close()


@pytest.fixture
def released(monkeypatch):
    """Run as the released CLI 0.1.733, which is supported but not the latest."""
    monkeypatch.setattr(env, "is_production", True)
    monkeypatch.setattr(env, "VERSION", "0.1.733")


def _write_cache(checked_at, policy=POLICY):
    upgrade.CACHE_PATH.write_text(
        json.dumps({"checked_at": checked_at, "policy": policy})
    )


def _cache():
    return json.loads(upgrade.CACHE_PATH.read_text())


@pytest.mark.parametrize(
    "data",
    [
        None,
        [],
        {"latest": "0.1.734"},
        {"latest": "0.1.735", "supported": ["0.1.734"]},
        {"latest": "v0.1.734", "supported": ["v0.1.734"]},
        {"latest": "0.1.734", "supported": "0.1.734"},
        {"latest": "0.1.734", "supported": ["0.1.734", 733]},
    ],
)
def test_a_malformed_policy_is_no_policy(data):
    assert upgrade.parse_policy(data) is None


def test_the_repository_policy_is_one_the_cli_reads():
    policy = json.loads((CLI_DIR / "supported-versions.json").read_text())

    latest, supported = upgrade.parse_policy(policy)

    assert supported[0] == latest
    assert len(supported) == 3


@pytest.mark.parametrize("version", ["0.1.734", "0.1.735", "0.1.735.dev0", "0.2.0"])
def test_the_latest_or_a_newer_build_gets_no_notice(version):
    assert upgrade.outdated_notice(version, upgrade.parse_policy(POLICY)) is None


def test_an_unknown_policy_or_version_gets_no_notice():
    assert upgrade.outdated_notice("0.1.700", None) is None
    assert upgrade.outdated_notice("unknown", upgrade.parse_policy(POLICY)) is None


@pytest.mark.parametrize("version", ["0.1.733.dev0", "0.1.733rc1", "0.1.732.post1"])
def test_a_build_of_a_supported_version_counts_as_supported(version):
    _, urgent = upgrade.outdated_notice(version, upgrade.parse_policy(POLICY))

    assert not urgent


def test_a_supported_older_version_is_told_a_newer_one_is_out():
    message, urgent = upgrade.outdated_notice("0.1.732", upgrade.parse_policy(POLICY))

    assert not urgent
    assert message == (
        "canyonos 0.1.734 is available (you have 0.1.732). "
        "Run `canyonos upgrade` to update."
    )


def test_an_unsupported_version_is_told_it_is_no_longer_maintained():
    message, urgent = upgrade.outdated_notice("0.1.731", upgrade.parse_policy(POLICY))

    assert urgent
    assert message == (
        "canyonos 0.1.731 is no longer maintained; the supported versions are "
        "0.1.734, 0.1.733, 0.1.732. Run `canyonos upgrade` to move to 0.1.734."
    )


def test_a_fresh_cache_answers_without_the_network(server):
    _write_cache(time.time() - 60, {"latest": "0.1.740", "supported": ["0.1.740"]})

    assert upgrade.load_policy() == ("0.1.740", ["0.1.740"])
    assert server.requests == 0


@pytest.mark.parametrize(
    "cache",
    [
        {"checked_at": time.time() - 25 * 60 * 60, "policy": POLICY},
        {"checked_at": time.time() + 60 * 60, "policy": POLICY},
        {"checked_at": "yesterday", "policy": POLICY},
        {"checked_at": time.time(), "policy": {"latest": "0.1.734"}},
        "not json",
    ],
    ids=["a day old", "from the future", "no timestamp", "bad policy", "corrupt"],
)
def test_a_stale_or_invalid_cache_is_refreshed_once(server, cache):
    server.body = {"latest": "0.1.740", "supported": ["0.1.740"]}
    upgrade.CACHE_PATH.write_text(
        cache if isinstance(cache, str) else json.dumps(cache)
    )

    assert upgrade.load_policy() == ("0.1.740", ["0.1.740"])
    assert upgrade.load_policy() == ("0.1.740", ["0.1.740"])
    assert server.requests == 1
    assert _cache()["policy"] == server.body


@pytest.mark.parametrize(
    "status, body",
    [
        (500, POLICY),
        (404, b"404: Not Found"),
        (200, b"<html>captive portal</html>"),
        (200, {"latest": "0.1.740"}),
    ],
    ids=["server error", "missing", "not json", "not a policy"],
)
def test_an_invalid_response_keeps_the_last_policy_for_another_day(
    server, status, body
):
    server.status, server.body = status, body
    _write_cache(time.time() - 25 * 60 * 60)

    assert upgrade.load_policy() == upgrade.parse_policy(POLICY)
    assert upgrade.load_policy() == upgrade.parse_policy(POLICY)
    assert server.requests == 1
    assert time.time() - _cache()["checked_at"] < 60


def test_offline_without_a_cache_means_no_policy_and_one_try_a_day():
    assert upgrade.load_policy() is None
    assert _cache()["policy"] is None
    assert upgrade.load_policy() is None


def test_a_slow_server_is_given_up_on_after_the_timeout(server, monkeypatch):
    monkeypatch.setattr(upgrade, "FETCH_TIMEOUT", 0.2)
    server.delay = 2

    started = time.monotonic()
    assert upgrade.load_policy() is None
    assert time.monotonic() - started < 1.5


def test_a_home_that_cannot_be_written_still_gets_the_policy(server, monkeypatch):
    blocker = upgrade.CACHE_PATH.parent / "not-a-directory"
    blocker.write_text("")
    monkeypatch.setattr(upgrade, "CACHE_PATH", blocker / "supported-versions.json")

    assert upgrade.load_policy() == upgrade.parse_policy(POLICY)


def test_a_development_cli_never_checks(server, monkeypatch, capsys):
    monkeypatch.setattr(env, "is_production", False)
    monkeypatch.setattr(env, "VERSION", "0.1.700")

    upgrade.notify_if_outdated()

    assert server.requests == 0
    assert capsys.readouterr() == ("", "")


def test_an_unexpected_failure_in_the_check_is_silent(released, monkeypatch, capsys):
    def broken():
        raise KeyError("anything")

    monkeypatch.setattr(upgrade, "load_policy", broken)

    upgrade.notify_if_outdated()

    assert capsys.readouterr() == ("", "")


def _run_cli(monkeypatch, *argv):
    monkeypatch.setattr(sys, "argv", ["canyonos", *argv])
    with pytest.raises(SystemExit) as exit_info:
        cli.main()
    return exit_info.value.code


def _fake_test_command(monkeypatch):
    """Replace the deploy behind `canyonos test` with one that prints its JSON result."""

    def run_test(prompt, as_json, timeout):
        upgrade.ui.set_quiet(as_json)
        print(json.dumps({"ok": True, "prompt": prompt}))
        return 0

    monkeypatch.setattr(cli, "run_test", run_test)
    monkeypatch.setattr(upgrade.ui.console, "quiet", False)


def test_the_notice_goes_to_stderr_and_leaves_json_on_stdout(
    server, released, monkeypatch, capsys
):
    _fake_test_command(monkeypatch)

    assert _run_cli(monkeypatch, "test", "hello", "--json") == 0

    out, err = capsys.readouterr()
    assert json.loads(out) == {"ok": True, "prompt": "hello"}
    assert "canyonos 0.1.734 is available (you have 0.1.733)" in _flat(err)
    assert server.requests == 1


def test_an_unsupported_cli_is_warned_and_still_runs_the_command(
    server, released, monkeypatch, capsys
):
    monkeypatch.setattr(env, "VERSION", "0.1.700")
    _fake_test_command(monkeypatch)

    assert _run_cli(monkeypatch, "test", "--json") == 0

    out, err = capsys.readouterr()
    assert json.loads(out)["ok"] is True
    assert "canyonos 0.1.700 is no longer maintained" in _flat(err)


def test_the_latest_cli_runs_the_command_without_a_notice(
    server, released, monkeypatch, capsys
):
    monkeypatch.setattr(env, "VERSION", "0.1.734")
    _fake_test_command(monkeypatch)

    assert _run_cli(monkeypatch, "test", "--json") == 0

    assert capsys.readouterr().err == ""


def test_offline_the_command_runs_without_a_notice(released, monkeypatch, capsys):
    _fake_test_command(monkeypatch)

    assert _run_cli(monkeypatch, "test", "--json") == 0

    out, err = capsys.readouterr()
    assert json.loads(out)["ok"] is True
    assert err == ""


def _cli_env(home):
    # Set even when empty, so a contributor's packages/cli/.env cannot override them.
    return {
        **os.environ,
        "HOME": str(home),
        "CANYONOS_ENV": "",
        "CANYONOS_CORE_IMAGE": "",
        "CANYONOS_SKILL_SOURCE": "",
        "CANYONOS_API_IMAGE": "",
        "CANYONOS_WEB_IMAGE": "",
    }


@pytest.mark.parametrize(
    "policy, expected",
    [
        ({"latest": "999.0.0", "supported": ["999.0.0"]}, "is no longer maintained"),
        (None, None),
    ],
    ids=["unsupported", "unknown policy"],
)
def test_the_installed_cli_keeps_validate_json_on_stdout(tmp_path, policy, expected):
    home = tmp_path / "home"
    (home / ".canyonos").mkdir(parents=True)
    (home / ".canyonos" / "supported-versions.json").write_text(
        json.dumps({"checked_at": time.time(), "policy": policy})
    )

    result = subprocess.run(
        [sys.executable, "-c", "import cli; cli.main()", "validate", "--json"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=60,
        env=_cli_env(home),
    )

    assert result.returncode == 2
    assert json.loads(result.stdout)["error"].startswith(".car is not a directory")
    if expected is None:
        assert result.stderr == ""
    else:
        assert expected in _flat(result.stderr)


@pytest.fixture
def fake_uv(tmp_path, monkeypatch):
    """A `uv` on PATH that logs its arguments, lists canyonos as `listed`, and exits
    `upgrade_status` from `uv tool upgrade`."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    state = tmp_path / "uv"
    state.mkdir()
    (state / "listed").write_text("canyonos v0.1.734\n- canyonos\n")
    (state / "upgrade_status").write_text("0")
    script = bin_dir / "uv"
    script.write_text(
        textwrap.dedent(
            f"""\
            #!/bin/sh
            echo "$*" >> {state}/log
            case "$*" in
                "tool upgrade canyonos") exit "$(cat {state}/upgrade_status)" ;;
                "tool list --show-version-specifiers") cat {state}/listed ;;
            esac
            """
        )
    )
    script.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
    return state


def _uv_calls(state):
    log = state / "log"
    return log.read_text().splitlines() if log.exists() else []


@pytest.fixture
def uv_tool_install(tmp_path, monkeypatch):
    """Run as if from the environment `uv tool install canyonos` made."""
    prefix = tmp_path / "tools" / "canyonos"
    prefix.mkdir(parents=True)
    (prefix / "uv-receipt.toml").write_text("[tool]\n")
    monkeypatch.setattr(sys, "prefix", str(prefix))


def test_upgrade_runs_uv_tool_upgrade_for_a_uv_install(
    fake_uv, uv_tool_install, server, released, monkeypatch, capsys
):
    assert _run_cli(monkeypatch, "upgrade") == 0

    assert _uv_calls(fake_uv) == [
        "tool upgrade canyonos",
        "tool list --show-version-specifiers",
    ]
    out, err = capsys.readouterr()
    assert out == ""
    assert err == ""


def test_upgrade_skips_the_outdated_notice(
    fake_uv, uv_tool_install, server, released, monkeypatch, capsys
):
    _write_cache(time.time() - 25 * 60 * 60)

    assert _run_cli(monkeypatch, "upgrade") == 0

    assert "is available" not in capsys.readouterr().err


def test_upgrade_keeps_a_constraint_that_holds_it_back_and_explains_it(
    fake_uv, uv_tool_install, server, released, monkeypatch, capsys
):
    (fake_uv / "listed").write_text(
        "canyonos v0.1.733 [required: <0.1.734]\n- canyonos\n"
    )

    assert _run_cli(monkeypatch, "upgrade") == 0

    assert "tool install" not in " ".join(_uv_calls(fake_uv))
    out = _flat(capsys.readouterr().out)
    assert (
        "canyonos stays at 0.1.733 because it was installed with the constraint "
        "`<0.1.734`, which uv keeps." in out
    )
    assert "uv tool install canyonos@latest" in out


def test_upgrade_says_nothing_of_a_constraint_the_latest_meets(
    fake_uv, uv_tool_install, server, released, monkeypatch, capsys
):
    (fake_uv / "listed").write_text(
        "canyonos v0.1.734 [required: >=0.1.0]\n- canyonos\n"
    )

    assert _run_cli(monkeypatch, "upgrade") == 0

    assert "constraint" not in capsys.readouterr().out


def test_upgrade_explains_a_pin_that_kept_it_unchanged_without_a_policy(
    fake_uv, uv_tool_install, released, monkeypatch, capsys
):
    (fake_uv / "listed").write_text(
        "canyonos v0.1.733 [required: ==0.1.733]\n- canyonos\n"
    )

    assert _run_cli(monkeypatch, "upgrade") == 0

    assert "uv tool install canyonos@latest" in _flat(capsys.readouterr().out)


def test_upgrade_passes_on_a_failed_uv_upgrade(
    fake_uv, uv_tool_install, server, released, monkeypatch
):
    (fake_uv / "upgrade_status").write_text("2")

    assert _run_cli(monkeypatch, "upgrade") == 2
    assert _uv_calls(fake_uv) == ["tool upgrade canyonos"]


def test_upgrade_without_uv_on_path_says_how_to_finish(
    uv_tool_install, released, monkeypatch, tmp_path, capsys
):
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))

    assert _run_cli(monkeypatch, "upgrade") == 1
    assert "Run `uv tool upgrade canyonos` once it is." in _flat(
        capsys.readouterr().out
    )


def test_upgrade_leaves_a_pip_install_alone_and_names_its_command(
    fake_uv, released, monkeypatch, capsys
):
    monkeypatch.setattr(upgrade.importlib.util, "find_spec", lambda name: object())

    assert _run_cli(monkeypatch, "upgrade") == 0

    assert _uv_calls(fake_uv) == []
    assert f"{sys.executable} -m pip install --upgrade canyonos" in _flat(
        capsys.readouterr().out
    )


def test_upgrade_names_uv_for_a_python_environment_without_pip(
    fake_uv, released, monkeypatch, capsys
):
    monkeypatch.setattr(upgrade.importlib.util, "find_spec", lambda name: None)

    assert _run_cli(monkeypatch, "upgrade") == 0

    assert f"uv pip install --python {sys.executable} --upgrade canyonos" in _flat(
        capsys.readouterr().out
    )


def test_upgrade_sees_through_the_homebrew_bin_symlink(
    fake_uv, released, monkeypatch, tmp_path, capsys
):
    cellar = tmp_path / "Cellar" / "canyonos" / "0.1.733" / "bin" / "canyonos"
    cellar.parent.mkdir(parents=True)
    cellar.write_text("")
    link = tmp_path / "homebrew" / "bin" / "canyonos"
    link.parent.mkdir(parents=True)
    link.symlink_to(cellar)
    monkeypatch.setattr(upgrade, "__compiled__", object(), raising=False)

    monkeypatch.setattr(sys, "argv", [str(link), "upgrade"])
    with pytest.raises(SystemExit) as exit_info:
        cli.main()

    assert exit_info.value.code == 0
    assert "brew upgrade canyonos" in _flat(capsys.readouterr().out)


@pytest.mark.parametrize(
    "location, expected",
    [
        ("Cellar/canyonos/0.1.733/bin", "brew upgrade canyonos"),
        (
            ".local/bin",
            f"curl -fsSL {upgrade.INSTALL_SCRIPT_URL} | sh",
        ),
        (
            "opt/tools",
            f"curl -fsSL {upgrade.INSTALL_SCRIPT_URL} | CANYONOS_INSTALL_DIR={{dir}} sh",
        ),
    ],
    ids=["homebrew", "install.sh", "install.sh elsewhere"],
)
def test_upgrade_names_the_reinstall_for_the_standalone_binary(
    fake_uv, released, monkeypatch, tmp_path, capsys, location, expected
):
    binary = tmp_path / location / "canyonos"
    binary.parent.mkdir(parents=True)
    binary.write_text("")
    monkeypatch.setattr(upgrade, "__compiled__", object(), raising=False)
    monkeypatch.setattr(upgrade, "DEFAULT_INSTALL_DIR", tmp_path / ".local" / "bin")

    monkeypatch.setattr(sys, "argv", [str(binary), "upgrade"])
    with pytest.raises(SystemExit) as exit_info:
        cli.main()

    assert exit_info.value.code == 0
    assert _uv_calls(fake_uv) == []
    assert expected.format(dir=os.path.realpath(binary.parent)) in _flat(
        capsys.readouterr().out
    )
