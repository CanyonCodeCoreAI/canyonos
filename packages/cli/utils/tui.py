# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Minimal arrow-key select menu, no dependency beyond the standard library.

Used by any command that involves selecting options, no other purpose beyond this.
"""

import sys

from canyonos.os_support import is_terminal, keypresses
from canyonos.theme import GREEN

UP_KEYS = ("\x1b[A", "\x1bOA", "k")
DOWN_KEYS = ("\x1b[B", "\x1bOB", "j")
CANCEL_KEYS = ("\x03", "\x1b")
ENTER_KEYS = ("\r", "\n")
TOGGLE_KEY = " "
DELETE_KEYS = ("d", "D")
QUIT_KEYS = ("q", "Q")

_GREEN = "\x1b[38;2;{};{};{}m".format(*(int(GREEN[i : i + 2], 16) for i in (1, 3, 5)))

# Sentinel returned (paired with the hovered value) when the delete key is
# pressed and `deletable=True`. Callers check `result[0] is DELETE_ACTION`.
DELETE_ACTION = object()

# Sentinel returned when the quit key is pressed and `quittable=True`. Distinct
# from None (which callers use for a single-level cancel/back) so a caller can
# unwind an entire nested session. Callers check `result is QUIT_ACTION`.
QUIT_ACTION = object()

# What a menu's key handler returns to keep the menu open.
MENU_CONTINUE = object()


def select_menu(
    options, title, deletable=False, quittable=False, footer=None, header=None
):
    """Arrow-key single-select over `options` (a list of (value, label) pairs).

    Returns the chosen value, or None if there's nothing to choose from or
    the user cancelled (Esc/Ctrl-C).

    If `deletable` is True, pressing the delete key ('d') over an item returns
    the tuple `(DELETE_ACTION, hovered_value)` so the caller can act on the
    currently-hovered item instead of selecting it.

    If `quittable` is True, pressing the quit key ('q') returns the sentinel
    `QUIT_ACTION` -- distinct from None -- so the caller can unwind an entire
    nested session rather than just this one menu.

    A label may span several lines (split on newlines); the cursor sits on its
    first line. `header` lines are drawn above the options and `footer` lines
    under them; neither can be selected.
    """
    if not options or not is_terminal(sys.stdin):
        return None
    n = len(options)
    # Shown only when single digits can reach every option.
    hints = [f"1-{n} jump", "enter select"] if 1 < n <= 9 else ["enter select"]
    if deletable:
        hints.append("d delete")
    if quittable:
        hints.append("q quit")

    def on_key(key, idx):
        if key in ENTER_KEYS:
            return options[idx][0]
        if deletable and key in DELETE_KEYS:
            return (DELETE_ACTION, options[idx][0])
        if quittable and key in QUIT_KEYS:
            return QUIT_ACTION
        if key.isdigit() and key != "0" and int(key) <= n:
            return options[int(key) - 1][0]
        return MENU_CONTINUE

    return _run_menu(options, title, hints, on_key, header=header, footer=footer)


def multi_select_menu(options, title, selected=()):
    """Arrow-key multi-select over `options` (a list of (value, label) pairs): space
    ticks or unticks the hovered option, enter confirms. The values in `selected`
    start ticked.

    Returns the ticked values in option order, possibly none, or None if there's
    nothing to choose from or the user cancelled (Esc/Ctrl-C).
    """
    if not options or not is_terminal(sys.stdin):
        return None
    ticked = {i for i, (value, _) in enumerate(options) if value in selected}

    def on_key(key, idx):
        if key in ENTER_KEYS:
            return [value for i, (value, _) in enumerate(options) if i in ticked]
        if key == TOGGLE_KEY:
            ticked.symmetric_difference_update({idx})
        return MENU_CONTINUE

    return _run_menu(
        options,
        title,
        ["space select", "enter confirm"],
        on_key,
        mark=lambda i: "◉" if i in ticked else "○",
    )


def _run_menu(options, title, hints, on_key, mark=None, header=None, footer=None):
    """Draw `options` (a list of (value, label) pairs) under `title` and move the
    cursor with the arrow keys until `on_key(key, idx)` returns a result, which is
    returned. `on_key` returns MENU_CONTINUE to keep the menu open, and None on
    Esc/Ctrl-C ends it. `mark(i)` prefixes each option's first line; `hints` go in
    the help line between moving and cancelling."""
    out = sys.stderr
    idx = 0
    n = len(options)

    def frame():
        lines = [f"\x1b[1m{title}\x1b[0m", ""]
        lines.extend(f"  {line}" for line in header or ())
        for i, (_, label) in enumerate(options):
            label_lines = str(label).splitlines() or [""]
            for j, line in enumerate(label_lines):
                if j == 0 and mark is not None:
                    line = f"{mark(i)} {line}"
                if i == idx and j == 0:
                    lines.append(f"{_GREEN}❯ {line}\x1b[0m")
                else:
                    lines.append(f"  {line}")
        lines.extend(f"  {line}" for line in footer or ())
        lines += ["", " · ".join(["↑/↓ move", *hints, "esc cancel"])]
        # Each line clears only its own leftover tail, so redraws overwrite in place.
        return "\x1b[K\r\n".join(lines) + "\x1b[K"

    prev_frame = None
    with keypresses(sys.stdin) as read_key:
        try:
            out.write("\x1b[?25l")
            while True:
                text = frame()
                # Synchronized update: supporting terminals paint the whole frame at once.
                out.write("\x1b[?2026h")
                if prev_frame is not None:
                    # How far back up to move is read off the frame we actually
                    # wrote last time, not recomputed separately -- it can't drift
                    # out of sync with what's really on screen.
                    out.write(f"\r\x1b[{prev_frame.count(chr(10))}A")
                out.write(text + "\x1b[J\x1b[?2026l")
                out.flush()
                prev_frame = text

                key = read_key()
                if key in CANCEL_KEYS:
                    return None
                if key in UP_KEYS:
                    idx = (idx - 1) % n
                elif key in DOWN_KEYS:
                    idx = (idx + 1) % n
                else:
                    result = on_key(key, idx)
                    if result is not MENU_CONTINUE:
                        return result
        finally:
            out.write("\x1b[?25h\r\n")
            out.flush()


def input_line(prompt, hint="enter save · esc back", error=None):
    """Read one line of typed text, with an optional red error under it; returns None on Esc/Ctrl-C."""
    if not is_terminal(sys.stdin):
        return None

    out = sys.stderr
    buffer = ""
    with keypresses(sys.stdin) as read_key:
        try:
            error_line = f"\x1b[1;31m✗ {error}\x1b[0m" if error else ""
            out.write(f"\x1b[?25h{prompt}\r\n{error_line}\r\n{hint}\x1b[2A")
            while True:
                out.write(f"\r\x1b[K{prompt}{buffer}")
                out.flush()
                key = read_key()
                if key in ENTER_KEYS:
                    return buffer.strip()
                if key in CANCEL_KEYS:
                    return None
                if key in ("\x7f", "\x08"):
                    buffer = buffer[:-1]
                elif len(key) == 1 and key.isprintable():
                    buffer += key
        finally:
            out.write("\r\n")
            out.flush()
