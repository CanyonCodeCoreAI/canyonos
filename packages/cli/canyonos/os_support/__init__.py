# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""What the CLI needs from the operating system, the same on Linux, macOS and Windows.

The rest of the CLI calls only these, never an OS-specific module: `_posix.py` and
`_windows.py` implement the same functions, and this is the one place that picks
between them. The lint config bans the OS-specific modules (termios, tty, fcntl,
msvcrt...) everywhere else in the CLI.
"""

import contextlib
import os
import subprocess

if os.name == "nt":
    from canyonos.os_support import _windows as _system
else:
    from canyonos.os_support import _posix as _system

__all__ = [
    "file_lock",
    "is_terminal",
    "keypresses",
    "make_private_dir",
    "prepare_console",
    "query_terminal",
    "shell_command",
    "spawn_detached",
    "write_private_file",
]

# Terminal
is_terminal = _system.is_terminal
keypresses = _system.keypresses
query_terminal = _system.query_terminal
prepare_console = _system.prepare_console

# A command the user can paste into their own shell
shell_command = _system.shell_command

# Files only you may read
write_private_file = _system.write_private_file
make_private_dir = _system.make_private_dir


@contextlib.contextmanager
def file_lock(path, *, wait, on_wait=None):
    """Hold an exclusive lock on the file at `path` (created if missing, never through
    a symlink) for the block, shared with every other process that locks it.

    Yields True once held. With `wait`, a lock another process holds is waited for,
    calling `on_wait` first; without it, yields False at once instead. Raises OSError
    when the file cannot be opened or locked.
    """
    descriptor = _system.open_lock_file(path)
    try:
        held = _system.try_lock(descriptor)
        if not held and wait:
            if on_wait is not None:
                on_wait()
            _system.wait_lock(descriptor)
            held = True
        yield held
    finally:
        # Closing the file releases the lock on every OS.
        os.close(descriptor)


def spawn_detached(argv, cwd=None):
    """Start `argv` with no input or output, detached from this terminal so it keeps
    running after the CLI exits and never gets the terminal's Ctrl+C. Returns at once."""
    subprocess.Popen(
        argv,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        cwd=cwd,
        close_fds=True,
        **_system.DETACHED_PROCESS_OPTIONS,
    )
