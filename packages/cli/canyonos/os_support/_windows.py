# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""os_support on Windows. Same functions as _posix.py; import os_support."""

import contextlib
import ctypes
import errno
import msvcrt
import os
import subprocess
import sys
import time

# Windows API constants, named as in the Windows SDK.
_STD_OUTPUT_HANDLE = -11
_STD_ERROR_HANDLE = -12
_ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004

# The console reports an arrow key as a "\x00" or "\xe0" prefix and then a scan code;
# they are handed on as the escape sequences a POSIX terminal sends.
_ARROW_KEYS = {"H": "\x1b[A", "P": "\x1b[B"}
_CTRL_C = "\x03"

# How often a held lock is retried: msvcrt can only wait 10 s before giving up.
_LOCK_RETRY_SECONDS = 0.1

# No console, and a process group of its own, so Ctrl+C in the terminal never reaches it.
DETACHED_PROCESS_OPTIONS = {
    "creationflags": subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
}


# Handles are pointer-sized and the mode is a DWORD; told to ctypes so nothing is
# truncated to a C int on the way in or out.
_INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value


def _kernel32():
    kernel32 = ctypes.windll.kernel32
    kernel32.GetStdHandle.argtypes = [ctypes.c_uint32]
    kernel32.GetStdHandle.restype = ctypes.c_void_p
    kernel32.GetConsoleMode.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_uint32),
    ]
    kernel32.GetConsoleMode.restype = ctypes.c_int
    kernel32.SetConsoleMode.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    kernel32.SetConsoleMode.restype = ctypes.c_int
    return kernel32


def _console_mode(handle):
    if handle in (None, _INVALID_HANDLE_VALUE):
        return None
    mode = ctypes.c_uint32()
    if _kernel32().GetConsoleMode(handle, ctypes.byref(mode)):
        return mode.value
    return None


def is_terminal(stream):
    """True when `stream` is an interactive console someone can type into or read.

    isatty() is also True for NUL (where Git Bash's /dev/null goes), as for any
    character device, and a menu opened there would wait on a key that never comes.
    Only a real console handle has a console mode.
    """
    if not stream.isatty():
        return False
    try:
        handle = msvcrt.get_osfhandle(stream.fileno())
    except (AttributeError, OSError, ValueError):
        # A stream with no file behind it (a wrapper or a stand-in): isatty() is all
        # there is to go on.
        return True
    return _console_mode(handle) is not None


def prepare_console():
    """Write stdout and stderr as UTF-8, and have the console interpret ANSI escapes.

    Output piped to another program otherwise falls back to the ANSI code page
    (cp1252), which has no ✓ or box-drawing characters, and the first one printed
    would crash. Windows Terminal interprets escapes already; the classic console
    host only once asked.
    """
    for stream in (sys.stdout, sys.stderr):
        # A test runner or IDE may have swapped in a stream that can't be changed.
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    kernel32 = _kernel32()
    for which in (_STD_OUTPUT_HANDLE, _STD_ERROR_HANDLE):
        handle = kernel32.GetStdHandle(which & 0xFFFFFFFF)
        mode = _console_mode(handle)
        if mode is None:
            continue
        # A console too old for escapes refuses; its output then shows them raw, as
        # it would any other program's.
        kernel32.SetConsoleMode(handle, mode | _ENABLE_VIRTUAL_TERMINAL_PROCESSING)


# How often the console is asked whether a key is waiting.
_KEY_POLL_SECONDS = 0.02


def _read_key():
    # getwch() blocks the whole process, and the console hands Ctrl+C to Python as a
    # signal rather than a key: polled, the signal lands during the sleep and the
    # menu cancels at once instead of on the next keypress.
    try:
        while not msvcrt.kbhit():
            time.sleep(_KEY_POLL_SECONDS)
        ch = msvcrt.getwch()
    except KeyboardInterrupt:
        return _CTRL_C
    if ch in ("\x00", "\xe0"):
        return _ARROW_KEYS.get(msvcrt.getwch(), "")
    return ch


@contextlib.contextmanager
def keypresses(stream):
    """Unechoed, one-key-at-a-time reads from the console for the block. Yields a
    function returning the next key: a character, or an arrow key's escape sequence."""
    # msvcrt reads that way already; there is no mode to set or restore.
    yield _read_key


def query_terminal(query, stdin, stdout, timeout):
    """ "": the console's replies to escape-sequence queries can't be read back without
    mixing them into the user's own input, so callers keep their default."""
    return ""


def shell_command(argv):
    """`argv` as one command line for PowerShell, the shell Windows opens by default,
    quoted the way Windows programs read their arguments (double quotes, never
    single). A quoted program name needs the call operator in front, or PowerShell
    reads the line as a string expression; cmd.exe runs the unquoted form the same."""
    line = subprocess.list2cmdline(argv)
    return f"& {line}" if line.startswith('"') else line


def write_private_file(path, contents):
    """Write `contents` (text) to `path`. Files under your user folder are already
    readable only by you through its access list; Windows has no mode bits to set."""
    with open(path, "w", encoding="utf-8", newline="") as output:
        output.write(contents)


def make_private_dir(path):
    """Create the folder `path` if needed. Under your user folder it is readable only by
    you through the folder's inherited access list."""
    path.mkdir(parents=True, exist_ok=True)


def open_lock_file(path):
    """Open (creating) a lock file. Windows only follows a symlink an administrator (or
    Developer Mode) let you create, so there is no planted link to refuse."""
    return os.open(path, os.O_RDWR | os.O_CREAT | os.O_BINARY, 0o600)


def try_lock(descriptor):
    """Take the file's exclusive lock if it is free; False if another process holds it."""
    # msvcrt locks bytes from the current position: always the first byte.
    os.lseek(descriptor, 0, os.SEEK_SET)
    try:
        msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
    except OSError as error:
        if error.errno in (errno.EACCES, errno.EDEADLK):
            return False
        raise
    return True


def wait_lock(descriptor):
    """Take the file's exclusive lock, waiting for as long as another process holds it."""
    while not try_lock(descriptor):
        time.sleep(_LOCK_RETRY_SECONDS)
