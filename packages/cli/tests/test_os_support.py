# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The OS layer behaves the same on every OS CI runs: Linux, macOS and Windows."""

import os
import stat
import threading
import time

import pytest

from canyonos import os_support


def test_a_held_lock_is_not_taken_twice(tmp_path):
    path = tmp_path / "x.lock"
    with os_support.file_lock(path, wait=False) as first:
        with os_support.file_lock(path, wait=False) as second:
            assert (first, second) == (True, False)


def test_a_lock_is_free_again_once_released(tmp_path):
    path = tmp_path / "x.lock"
    with os_support.file_lock(path, wait=False):
        pass
    with os_support.file_lock(path, wait=False) as held:
        assert held


def test_waiting_for_a_held_lock_says_so_then_takes_it(tmp_path):
    path = tmp_path / "x.lock"
    taken = threading.Event()
    waits = []

    def hold_briefly():
        with os_support.file_lock(path, wait=False):
            taken.set()
            time.sleep(0.3)

    holder = threading.Thread(target=hold_briefly)
    holder.start()
    taken.wait()
    with os_support.file_lock(path, wait=True, on_wait=lambda: waits.append(1)) as held:
        assert held
    holder.join()
    assert waits == [1]


def test_a_private_file_holds_exactly_what_was_written(tmp_path):
    path = tmp_path / ".env"
    os_support.write_private_file(path, "A=1\nB=2\n")

    # No newline translation on Windows: the bytes are the text given.
    assert path.read_bytes() == b"A=1\nB=2\n"


@pytest.mark.posix_only("Windows has no permission bits")
def test_a_private_file_is_readable_only_by_you_even_if_it_was_not(tmp_path):
    path = tmp_path / ".env"
    path.write_text("old", encoding="utf-8")
    path.chmod(0o644)

    os_support.write_private_file(path, "new")

    assert stat.S_IMODE(path.stat().st_mode) == 0o600


@pytest.mark.posix_only("Windows has no permission bits")
def test_a_private_folder_is_tightened_if_it_already_exists(tmp_path):
    folder = tmp_path / "state"
    folder.mkdir(mode=0o755)

    os_support.make_private_dir(folder)

    assert stat.S_IMODE(folder.stat().st_mode) == 0o700


def test_a_detached_process_has_no_terminal_and_no_output(monkeypatch):
    started = []
    monkeypatch.setattr(
        os_support.subprocess, "Popen", lambda argv, **kw: started.append((argv, kw))
    )

    os_support.spawn_detached(["canyonos", "--deliver"], cwd="/somewhere")

    [(argv, options)] = started
    assert argv == ["canyonos", "--deliver"]
    for stream in ("stdin", "stdout", "stderr"):
        assert options[stream] is os_support.subprocess.DEVNULL
    assert options["cwd"] == "/somewhere"
    assert options.items() >= os_support._system.DETACHED_PROCESS_OPTIONS.items()


def test_a_file_is_not_a_terminal(tmp_path):
    with open(tmp_path / "out.txt", "w", encoding="utf-8") as stream:
        assert not os_support.is_terminal(stream)


def test_the_null_device_is_not_a_terminal():
    # On Windows NUL reports isatty(); a menu opened on it would wait forever.
    with open(os.devnull, encoding="utf-8") as stream:
        assert not os_support.is_terminal(stream)


@pytest.mark.windows_only("the Windows console's own key codes")
def test_windows_arrow_keys_read_as_the_posix_escape_sequences(monkeypatch):
    from canyonos.os_support import _windows

    keys = iter(["\xe0", "H", "\x00", "P", "q"])
    monkeypatch.setattr(_windows.msvcrt, "kbhit", lambda: True)
    monkeypatch.setattr(_windows.msvcrt, "getwch", lambda: next(keys))

    with os_support.keypresses(None) as read_key:
        assert [read_key(), read_key(), read_key()] == ["\x1b[A", "\x1b[B", "q"]


@pytest.mark.windows_only("PowerShell's call operator")
def test_windows_shell_command_calls_a_quoted_program_through_the_call_operator():
    from canyonos.os_support import _windows

    python = r"C:\Program Files\Python312\python.exe"
    assert _windows.shell_command([python, "-m", "pip"]) == f'& "{python}" -m pip'
    assert _windows.shell_command(["uv", "pip", "--python", python]) == (
        f'uv pip --python "{python}"'
    )
