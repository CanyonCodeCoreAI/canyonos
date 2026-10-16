# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Sends the usage events waiting in `~/.canyonos/usage/outbox/` to the usage API selected
by `canyonos.env`. Every `canyonos` run ends by starting a background copy of the CLI
that does the sending, so it never slows a command down, shows anything or changes how
the command exits. Events stay in the outbox until the API has stored them.
"""

import fcntl
import http.client
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

from canyonos import env
from canyonos.env import VERSION
from canyonos.usage.outbox import (
    REPORTED_COMMANDS,
    is_reportable_version,
    pending_events,
)
from canyonos.usage.settings import is_uuid4, load_settings, outbox_dir, usage_dir

DELIVERY_ARGUMENT = "__usage-delivery"
EVENTS_PATH = "/usage/events"
# Must match MAX_EVENTS_PER_BATCH in packages/cli-usage-api/src/usage.contract.ts.
MAX_EVENTS_PER_REQUEST = 25
REQUEST_TIMEOUT_SECONDS = 5
MAX_EVENT_FILE_BYTES = 1024
STALE_TEMPORARY_FILE_SECONDS = 60 * 60
EVENT_KEYS = frozenset(
    {
        "event_id",
        "installation_id",
        "command",
        "succeeded",
        "occurred_at",
        "cli_version",
    }
)
# Zod's UTC datetime, with the fraction bounded so a full batch stays under the API's
# 16 KiB body limit.
UTC_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$")


def delivery_command() -> list[str]:
    """How to start this same CLI again as the background sender. A released binary
    restarts itself: its bundled Python lives in a folder that is deleted as soon as
    this run exits. A Python install starts its interpreter on the installed CLI."""
    if "__compiled__" in globals():
        return [os.path.abspath(sys.argv[0]), DELIVERY_ARGUMENT]
    return [sys.executable, "-c", "import cli; cli.main()", DELIVERY_ARGUMENT]


def _reporting_is_on() -> bool:
    settings = load_settings()
    return settings is not None and settings.usage_reporting


def start_delivery() -> None:
    """Start sending the waiting usage events in the background as a `canyonos` run
    ends, when usage reporting is on, events are waiting and a usage API is selected.
    Return at once without waiting for it; never show anything or raise."""
    try:
        if env.usage_url is None or not _reporting_is_on() or not pending_events():
            return
        subprocess.Popen(
            delivery_command(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            cwd=usage_dir(),
            start_new_session=True,
            close_fds=True,
        )
    # Usage reporting must never change what the command printed or how it exited.
    except Exception:
        pass


def _is_utc_timestamp(value: object) -> bool:
    if not isinstance(value, str) or not UTC_TIMESTAMP.match(value):
        return False
    try:
        datetime.strptime(value[:19], "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return False
    return True


def is_valid_event(event: object) -> bool:
    """Whether an outbox file holds an event the usage API accepts. Anything else, such
    as a hand-edited file, would make the API reject the whole batch it is sent in."""
    return (
        isinstance(event, dict)
        and set(event) == EVENT_KEYS
        and is_uuid4(event["event_id"])
        and is_uuid4(event["installation_id"])
        and event["command"] in REPORTED_COMMANDS
        and isinstance(event["succeeded"], bool)
        and _is_utc_timestamp(event["occurred_at"])
        and isinstance(event["cli_version"], str)
        and is_reportable_version(event["cli_version"])
    )


def _read_event(path: Path) -> dict | None:
    try:
        with path.open("rb") as source:
            raw = source.read(MAX_EVENT_FILE_BYTES + 1)
        event = json.loads(raw)
    except (OSError, ValueError):
        return None
    if len(raw) > MAX_EVENT_FILE_BYTES or not is_valid_event(event):
        return None
    return event


def _discard(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def _next_batch() -> list[tuple[Path, dict]]:
    batch = []
    for path in pending_events():
        event = _read_event(path)
        if event is None:
            _discard(path)
            continue
        batch.append((path, event))
        if len(batch) == MAX_EVENTS_PER_REQUEST:
            break
    return batch


def _remove_stale_temporary_files() -> None:
    cutoff = time.time() - STALE_TEMPORARY_FILE_SECONDS
    for path in outbox_dir().glob(".*.tmp"):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
        except OSError:
            continue


class _RefuseRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


_opener = urllib.request.build_opener(_RefuseRedirects)


def send_events(url: str, events: list[dict]) -> bool:
    """POST one batch of events to the usage API at `url`. Return whether it answered
    200, which means it stored every one of them; any other answer, a redirect, a
    timeout or no answer at all returns False."""
    request = urllib.request.Request(
        url + EVENTS_PATH,
        data=json.dumps({"events": events}, separators=(",", ":")).encode(),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "User-Agent": f"canyonos/{VERSION}",
        },
    )
    try:
        with _opener.open(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            return response.status == 200
    except (OSError, http.client.HTTPException):
        return False


def _deliver(url: str) -> None:
    _remove_stale_temporary_files()
    while _reporting_is_on():
        batch = _next_batch()
        if not batch or not send_events(url, [event for _path, event in batch]):
            return
        for path, _event in batch:
            path.unlink(missing_ok=True)


def deliver_pending_events() -> None:
    """Run by the background copy of the CLI: send the waiting events to the usage API
    oldest first, a batch at a time, deleting each batch once it is stored. Stop at the
    first failure or when usage reporting is turned off, keeping what is left for the
    next run. Files that are not valid events are deleted. If another copy is already
    sending, return at once."""
    url = env.usage_url
    if url is None:
        return
    try:
        lock = os.open(
            usage_dir() / "delivery.lock",
            os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,
            0o600,
        )
    except OSError:
        return
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        _deliver(url)
    # Running detached with nowhere to report to: whatever is left waits for next time.
    except Exception:
        pass
    finally:
        os.close(lock)
