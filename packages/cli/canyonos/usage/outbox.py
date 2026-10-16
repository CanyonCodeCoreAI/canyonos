# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Usage events waiting to be sent, one file each in `~/.canyonos/usage/outbox/`. A
command that acts on your app or its workflow adds one while usage reporting is on:
the command name, whether it succeeded, when it ran, the CLI version and your random
installation id. Nothing about its arguments, files or environment is kept.
"""

import re
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from canyonos.env import VERSION
from canyonos.usage.settings import (
    ensure_private_dir,
    load_settings,
    outbox_dir,
    write_private_json,
)

# Must match REPORTED_COMMANDS in packages/cli-usage-api/src/usage.contract.ts.
REPORTED_COMMANDS = frozenset(
    {
        "new-app",
        "build",
        "validate",
        "deploy",
        "test",
        "serve",
        "stop",
        "clean",
        "quit",
    }
)
MAX_PENDING_EVENTS = 1000
MAX_CLI_VERSION_LENGTH = 64
SEMVER_LIKE = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$")


def is_reportable_version(version: str) -> bool:
    """Whether the usage API accepts `version` as a CLI version. A development build's
    version such as `0.2.0.dev1` is not, and its events would be rejected."""
    return len(version) <= MAX_CLI_VERSION_LENGTH and bool(SEMVER_LIKE.match(version))


def build_event(
    command: str, succeeded: bool, installation_id: str, occurred_at: datetime
) -> dict:
    """The usage event for one run of `command`, in the shape the usage API accepts."""
    utc = occurred_at.astimezone(timezone.utc)
    return {
        "event_id": str(uuid.uuid4()),
        "installation_id": installation_id,
        "command": command,
        "succeeded": succeeded,
        "occurred_at": utc.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "cli_version": VERSION,
    }


def pending_events() -> list[Path]:
    """The event files waiting in the outbox, oldest written first, or none if there is
    no outbox. Files are not opened, so a malformed one is listed like any other."""
    stamped = []
    try:
        for path in outbox_dir().glob("*.json"):
            try:
                stamped.append((path.stat().st_mtime_ns, path.name, path))
            except FileNotFoundError:
                continue
    except OSError:
        return []
    return [path for _mtime, _name, path in sorted(stamped)]


def _make_room() -> None:
    pending = pending_events()
    for oldest in pending[: max(0, len(pending) - MAX_PENDING_EVENTS + 1)]:
        oldest.unlink(missing_ok=True)


def record_event(command: str, succeeded: bool) -> None:
    """Add a usage event for `command` to the outbox when usage reporting is on and the
    command is one that is reported. A full outbox drops its oldest event first."""
    settings = load_settings()
    if command not in REPORTED_COMMANDS or settings is None:
        return
    if not settings.usage_reporting or settings.installation_id is None:
        return
    if not is_reportable_version(VERSION):
        return
    event = build_event(
        command, succeeded, settings.installation_id, datetime.now(timezone.utc)
    )
    ensure_private_dir(outbox_dir())
    _make_room()
    write_private_json(outbox_dir() / f"{event['event_id']}.json", event)


def _record_quietly(command: str, succeeded: bool) -> None:
    try:
        record_event(command, succeeded)
    # Usage reporting must never change what the command printed or how it exited.
    except Exception:
        pass


@contextmanager
def recording_usage(command: str) -> Iterator[None]:
    """Run the `canyonos` command inside this block and add its usage event when it
    ends: succeeded when it returns or exits with status 0, failed on any other exit,
    error or Ctrl-C. Its own result or error passes through untouched."""
    succeeded = False
    try:
        yield
        succeeded = True
    except SystemExit as exiting:
        succeeded = exiting.code in (0, None)
        raise
    finally:
        _record_quietly(command, succeeded)
