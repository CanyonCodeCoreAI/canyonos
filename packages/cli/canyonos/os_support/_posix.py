# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""os_support on Linux and macOS. Same functions as _windows.py; import os_support."""

import contextlib
import fcntl
import os
import select
import shlex
import termios
import tty

PRIVATE_FILE_MODE = 0o600
PRIVATE_DIR_MODE = 0o700

# A new session: no controlling terminal, so the terminal's signals never reach it.
DETACHED_PROCESS_OPTIONS = {"start_new_session": True}


def is_terminal(stream):
    """True when `stream` is an interactive terminal someone can type into or read."""
    return stream.isatty()


def prepare_console():
    """Nothing to do: POSIX terminals take UTF-8 and ANSI escapes as they are."""


def _read_key(fd):
    # Reads straight off the fd (not sys.stdin) so this stays in sync with
    # the select() call below -- stdin's own buffering can silently swallow
    # an arrow key's trailing bytes before select() ever sees them queued.
    ch = os.read(fd, 1).decode()
    if ch == "\x1b":
        # An arrow key arrives as a multi-byte escape sequence; a bare Esc
        # press has nothing queued right behind it.
        if select.select([fd], [], [], 0.01)[0]:
            ch += os.read(fd, 1).decode()
            if ch[-1] in ("[", "O"):
                ch += os.read(fd, 1).decode()
    return ch


@contextlib.contextmanager
def keypresses(stream):
    """Unechoed, one-key-at-a-time reads from `stream` for the block. Yields a function
    returning the next key: a character, or an arrow key's escape sequence."""
    fd = stream.fileno()
    old_settings = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        yield lambda: _read_key(fd)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)


def query_terminal(query, stdin, stdout, timeout):
    """Write `query` (an escape sequence the terminal answers) and return its reply,
    or "" when none comes within `timeout` seconds."""
    fd = stdin.fileno()
    old_settings = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        stdout.write(query)
        stdout.flush()
        if select.select([fd], [], [], timeout)[0]:
            return os.read(fd, 32).decode(errors="ignore")
        return ""
    finally:
        # A reply that arrives just after the timeout (or a second stray one)
        # would otherwise sit in the tty buffer and be echoed as literal text
        # once cooked mode is back -- drain it, non-blockingly, first.
        while select.select([fd], [], [], 0)[0]:
            if not os.read(fd, 1024):
                break
        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)


def shell_command(argv):
    """`argv` as one command line for a POSIX shell, quoted where it has to be."""
    return shlex.join(argv)


def write_private_file(path, contents):
    """Write `contents` (text) to `path`, readable only by you from the moment it
    exists. A file that already exists with looser permissions is tightened too."""
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, PRIVATE_FILE_MODE)
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        # The open mode only applies when creating the file.
        os.fchmod(output.fileno(), PRIVATE_FILE_MODE)
        output.write(contents)


def make_private_dir(path):
    """Create the folder `path` if needed, readable only by you; one that already
    exists with looser permissions is tightened."""
    path.mkdir(mode=PRIVATE_DIR_MODE, parents=True, exist_ok=True)
    os.chmod(path, PRIVATE_DIR_MODE)


def open_lock_file(path):
    """Open (creating) a lock file, refusing to follow a symlink planted in its place."""
    return os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, PRIVATE_FILE_MODE)


def try_lock(descriptor):
    """Take the file's exclusive lock if it is free; False if another process holds it."""
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return False
    return True


def wait_lock(descriptor):
    """Take the file's exclusive lock, waiting for as long as another process holds it."""
    fcntl.flock(descriptor, fcntl.LOCK_EX)
