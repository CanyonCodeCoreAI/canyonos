# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Your usage reporting choice, kept in `~/.canyonos/usage/settings.json`. The file is
written once you answer the question after your first deploy or run `canyonos
contact`; until then reporting is off. Every file here is private to you and replaced
in one step, so an interrupted write never leaves half a file behind.
"""

import json
import os
import shutil
import tempfile
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path

PRIVATE_DIR_MODE = 0o700


@dataclass(frozen=True)
class UsageSettings:
    """Whether usage reporting is on and, while it is, the random id it reports under."""

    usage_reporting: bool
    installation_id: str | None


def usage_dir() -> Path:
    """The folder under your home directory that holds everything usage reporting keeps."""
    return Path.home() / ".canyonos" / "usage"


def settings_path() -> Path:
    """Where your usage reporting choice is saved."""
    return usage_dir() / "settings.json"


def outbox_dir() -> Path:
    """Where usage events wait, one file each, until they are sent."""
    return usage_dir() / "outbox"


def is_uuid4(value: object) -> bool:
    """Whether `value` is a random id written the way the usage API accepts it: a
    version 4 UUID in lowercase."""
    if not isinstance(value, str):
        return False
    try:
        parsed = uuid.UUID(value)
    except ValueError:
        return False
    return parsed.version == 4 and str(parsed) == value


def load_settings() -> UsageSettings | None:
    """Read your saved usage reporting choice. Return None when you haven't been asked
    yet, which includes a settings file that is missing, unreadable or malformed."""
    try:
        raw = json.loads(settings_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(raw, dict):
        return None

    reporting = raw.get("usage_reporting")
    installation_id = raw.get("installation_id")
    if reporting is True and is_uuid4(installation_id):
        return UsageSettings(True, installation_id)
    if reporting is False and installation_id is None:
        return UsageSettings(False, None)
    return None


def ensure_private_dir(path: Path) -> None:
    """Create `path` if needed and make it readable only by you, tightening a folder
    that already exists with looser permissions."""
    path.mkdir(mode=PRIVATE_DIR_MODE, parents=True, exist_ok=True)
    os.chmod(path, PRIVATE_DIR_MODE)


def write_private_json(path: Path, data: dict) -> None:
    """Write `data` as JSON to `path`, readable only by you, replacing any previous file
    in one step so a reader sees either the old contents or the new ones."""
    descriptor, temporary_path = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(data, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_path, path)
    except BaseException:
        Path(temporary_path).unlink(missing_ok=True)
        raise


def _save_settings(settings: UsageSettings) -> None:
    ensure_private_dir(usage_dir())
    write_private_json(settings_path(), asdict(settings))


def purge_outbox() -> None:
    """Delete every usage event still waiting to be sent, leaving the empty outbox."""
    try:
        entries = list(outbox_dir().iterdir())
    except FileNotFoundError:
        return
    for entry in entries:
        if entry.is_dir() and not entry.is_symlink():
            shutil.rmtree(entry)
        else:
            entry.unlink(missing_ok=True)


def set_usage_reporting(enabled: bool) -> UsageSettings:
    """Save your usage reporting choice and return it. Turning it on again while it is
    already on keeps the same installation id; turning it on after it was off starts a
    new one. Turning it off forgets the id and deletes the events not sent yet."""
    current = load_settings()
    if enabled:
        if current is not None and current.usage_reporting:
            return current
        settings = UsageSettings(True, str(uuid.uuid4()))
        _save_settings(settings)
        return settings

    settings = UsageSettings(False, None)
    _save_settings(settings)
    purge_outbox()
    return settings
