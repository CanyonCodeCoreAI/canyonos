# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import shlex
from types import SimpleNamespace

import pytest

from canyonos import aws_provision, dev_machine, env

SSH = dev_machine.ssh_command("/keys/k.pem", "203.0.113.7", "ubuntu")


def test_the_build_never_replaces_the_local_dev_image():
    assert dev_machine.BUILD_TAG != env.LOCAL_CORE_IMAGE


def test_ssh_never_prompts_and_accepts_the_new_machine():
    assert SSH[-1] == "ubuntu@203.0.113.7"
    assert "BatchMode=yes" in SSH
    assert "StrictHostKeyChecking=accept-new" in SSH


def test_the_checkout_is_copied_without_build_output_or_the_local_env():
    command = dev_machine.sync_command(SSH, "canyonos")

    assert command[-1] == "ubuntu@203.0.113.7:canyonos/"
    assert command[-2] == f"{env.REPO_ROOT}/"
    for pattern in (".git", ".venv", "node_modules", "packages/cli/.env"):
        assert f"--exclude={pattern}" in command
    # rsync's ssh runs the same options, without the destination.
    assert command[command.index("-e") + 1] == shlex.join(SSH[:-1])


def test_the_image_is_loaded_and_tagged_as_the_dev_image_there():
    pipeline = dev_machine.ship_command(SSH, "zstd")

    assert pipeline.startswith(f"docker save {dev_machine.BUILD_TAG} | zstd -c")
    assert "zstd -dc | docker load" in pipeline
    assert f"docker tag {dev_machine.BUILD_TAG} {env.LOCAL_CORE_IMAGE}" in pipeline


def test_without_zstd_here_the_image_goes_gzipped():
    pipeline = dev_machine.ship_command(SSH)

    assert "gzip -1 -c" in pipeline and "gunzip -c | docker load" in pipeline


def test_the_cli_is_installed_from_the_checkout_in_development_mode():
    command = dev_machine.install_command("canyonos")

    assert "CANYONOS_ENV=development" in dev_machine.REMOTE_ENV
    assert "CANYONOS_CORE_IMAGE=local" in dev_machine.REMOTE_ENV
    assert "> ~/canyonos/packages/cli/.env" in command
    assert "--editable ~/canyonos/packages/cli" in command


def _results(*codes):
    results = iter(codes)
    return lambda *args, **kwargs: SimpleNamespace(
        returncode=next(results), stderr="Connection refused"
    )


def test_boot_waits_while_ssh_is_not_up_yet(monkeypatch):
    monkeypatch.setattr(dev_machine.time, "sleep", lambda _: None)
    monkeypatch.setattr(dev_machine.subprocess, "run", _results(255, 255, 0))

    dev_machine.wait_for_boot(SSH)


def test_a_failed_boot_script_stops_provisioning(monkeypatch):
    monkeypatch.setattr(dev_machine.subprocess, "run", _results(1))

    with pytest.raises(dev_machine.DevMachineError, match="cloud-init-output.log"):
        dev_machine.wait_for_boot(SSH)


def test_a_machine_that_never_answers_stops_provisioning(monkeypatch):
    monkeypatch.setattr(dev_machine.time, "sleep", lambda _: None)
    monkeypatch.setattr(dev_machine.subprocess, "run", _results(255, 255))

    with pytest.raises(dev_machine.DevMachineError, match="Connection refused"):
        dev_machine.wait_for_boot(SSH, timeout_seconds=0)


def test_a_dev_machine_boots_ready_for_the_checkout_not_the_release():
    script = aws_provision.user_data("1.2.3", dev=True)

    assert "astral.sh/uv/0.12.15/install.sh" in script
    assert "rsync" in script
    assert "CANYONOS_VERSION" not in script
