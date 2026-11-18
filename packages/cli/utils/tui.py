# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Minimal arrow-key select menu, no dependency beyond the standard library.

Used by any command that involves selecting options, no other purpose beyond this.
"""

import shutil
import sys

from rich.cells import cell_len, set_cell_size

from canyonos.os_support import is_terminal, keypresses, keys_waiting, on_resize
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


def input_form(labels, hint, error=None, commands=None, history=()):
    """Draw a box to type in for each of `labels`, all at once at the bottom of the
    terminal, with `hint` and an optional red `error` under them; output printed while
    no form is open scrolls above them. Tab or ↓ moves to the next box, shift-tab or ↑
    back; in a box ← → Home End move, Delete and Backspace erase, and Ctrl-U erases up
    to the cursor. Enter returns what each box holds, in order; a newline pasted with
    more text stays in the box. Ctrl-P and Ctrl-N fill the boxes from `history`, earlier
    returns oldest first. The `commands` (name to description) that start with what the
    first box holds replace the hint, and tab fills in the first of them. Returns None
    on Ctrl-C or Ctrl-D."""
    if not is_terminal(sys.stdin):
        return None

    out = sys.stderr
    values = [""] * len(labels)
    cursors = [0] * len(labels)
    idx = 0
    back = len(history)
    # Three lines a box, then the hint and error lines.
    height = 3 * len(labels) + 2
    drawn_top = None

    def suggestions():
        if idx or not values[0].startswith("/"):
            return []
        return [command for command in commands or {} if command.startswith(values[0])]

    def draw():
        nonlocal drawn_top
        columns, rows = shutil.get_terminal_size()
        width, top = columns - 1, rows - height + 1
        inner = width - 4
        # Each box shows the stretch of its text, in screen columns, that holds its cursor.
        starts = []
        for value, cursor in zip(values, cursors):
            start = max(0, cursor - inner)
            while cell_len(value[start:cursor]) > inner:
                start += 1
            starts.append(start)
        lines = []
        for i, label in enumerate(labels):
            color = _GREEN if i == idx else "\x1b[2m"
            border = f"╭─ {label} "[: width - 1]
            lines.append(f"{color}{border}{'─' * (width - 1 - len(border))}╮\x1b[0m")
            text = values[i][starts[i] :].replace("\n", "⏎")
            text = set_cell_size(text, inner)
            lines.append(f"{color}│\x1b[0m {text} {color}│\x1b[0m")
            lines.append(f"{color}╰{'─' * (width - 2)}╯\x1b[0m")
        # Cut to the width: a line wrapping past the last row would scroll the screen.
        found = suggestions()
        if found:
            plain = f"{'  '.join(found)}  {commands[found[0]]}"[:width]
            first = len(found[0])
            lines.append(f"{_GREEN}{plain[:first]}\x1b[0m{plain[first:]}")
        else:
            lines.append(f"\x1b[2m{hint[:width]}\x1b[0m")
        lines.append(f"\x1b[1;31m{f'✗ {error}'[:width]}\x1b[0m" if error else "")
        # Keep scrolling output above the form, wipe where a resize left the last one,
        # then park the cursor in the focused box.
        out.write(f"\x1b[?2026h\x1b[1;{top - 1}r")
        if drawn_top not in (None, top):
            out.write(f"\x1b[{min(top, drawn_top)};1H\x1b[J")
        for row, line in enumerate(lines, top):
            out.write(f"\x1b[{row};1H{line}\x1b[K")
        column = 3 + cell_len(values[idx][starts[idx] : cursors[idx]])
        out.write(f"\x1b[{top + 3 * idx + 1};{column}H\x1b[?2026l")
        out.flush()
        drawn_top = top

    # Clear an earlier form under the output, scroll up to make room for this one, and
    # remember where output was printing, so it carries on there once the form is done.
    out.write("\x1b7\x1b[r\x1b8\x1b[J" + "\x1bD" * height + f"\x1b[{height}A\x1b7")
    with keypresses(sys.stdin) as read_key, on_resize(draw):
        try:
            while True:
                draw()
                key = read_key()
                if key in ("\x03", "\x04"):
                    return None
                if key in ENTER_KEYS and not keys_waiting(sys.stdin):
                    return [value.strip() for value in values]
                if key == "\t" and suggestions():
                    values[0] = suggestions()[0] + " "
                    cursors[0] = len(values[0])
                elif key in ("\t", "\x1b[B", "\x1bOB"):
                    idx = (idx + 1) % len(labels)
                elif key in ("\x1b[Z", "\x1b[A", "\x1bOA"):
                    idx = (idx - 1) % len(labels)
                elif key in ("\x1b[D", "\x1bOD"):
                    cursors[idx] = max(0, cursors[idx] - 1)
                elif key in ("\x1b[C", "\x1bOC"):
                    cursors[idx] = min(len(values[idx]), cursors[idx] + 1)
                elif key in ("\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[7~", "\x01"):
                    cursors[idx] = 0
                elif key in ("\x1b[F", "\x1bOF", "\x1b[4~", "\x1b[8~", "\x05"):
                    cursors[idx] = len(values[idx])
                elif key in ("\x7f", "\x08") and cursors[idx]:
                    at = cursors[idx]
                    values[idx] = values[idx][: at - 1] + values[idx][at:]
                    cursors[idx] -= 1
                elif key == "\x1b[3~":
                    at = cursors[idx]
                    values[idx] = values[idx][:at] + values[idx][at + 1 :]
                elif key == "\x15":
                    values[idx] = values[idx][cursors[idx] :]
                    cursors[idx] = 0
                elif key in ("\x10", "\x0e") and history:
                    step = -1 if key == "\x10" else 1
                    back = min(max(back + step, 0), len(history))
                    values = (
                        list(history[back])
                        if back < len(history)
                        else [""] * len(labels)
                    )
                    cursors = [len(value) for value in values]
                elif key in ENTER_KEYS or (len(key) == 1 and key.isprintable()):
                    at = cursors[idx]
                    typed = "\n" if key in ENTER_KEYS else key
                    values[idx] = values[idx][:at] + typed + values[idx][at:]
                    cursors[idx] += 1
        finally:
            values, cursors = [""] * len(labels), [0] * len(labels)
            draw()
            out.write("\x1b8")
            out.flush()
