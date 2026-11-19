# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Read a workflow archive the CLI uploads to the server's
`PUT /v1/workflow-groups/<workflow_group_id>/workflows/<name>`: list and fingerprint
its entries, and remove from the workspace what the previous upload had and this one
lacks."""

import errno
import hashlib
import os
from contextlib import suppress

from canyonos_core.schema import DEPLOYMENT_CONFIG
from canyonos_core.stub_generator import _SKIPPED_DIRS


def archive_entries(members):
    """Return each archive member's path and kind, "directory" or "entry". Raises
    ValueError for an absolute path or one with an empty, `.` or `..` part."""
    entries = {}
    for member in members:
        if any(part in ("", ".", "..") for part in member.name.split("/")):
            raise ValueError(f"Unsafe path in the archive: {member.name!r}")
        entries[member.name] = "directory" if member.isdir() else "entry"
    return entries


def archive_digests(archive, members):
    """Return the SHA-256 of each file in the archive, by path. Folders the image build
    skips, such as `.venv`, are left out, and a symlink counts by its target text."""
    digests = {}
    for member in members:
        parts = member.name.split("/")
        if member.isdir() or any(
            name.startswith(".") or name in _SKIPPED_DIRS or name.endswith(".egg-info")
            for name in parts[:-1]
        ):
            continue
        if member.issym():
            digests[member.name] = hashlib.sha256(member.linkname.encode()).hexdigest()
            continue
        digest = hashlib.sha256()
        with archive.extractfile(member) as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                digest.update(chunk)
        digests[member.name] = digest.hexdigest()
    return digests


def fingerprints(digests):
    """Return SHA-256 digests over the files in `digests`: `config` for
    `workflow_group.yaml`, the `.env` files and each workflow's `config/` files, which a
    reload applies (replicas it starts read the new `.env`), and `code` for the rest,
    which needs a redeploy."""
    parts = {"code": hashlib.sha256(), "config": hashlib.sha256()}
    for path, digest in sorted(digests.items()):
        is_config = (
            path == DEPLOYMENT_CONFIG
            or path.rsplit("/", 1)[-1] == ".env"
            or path.split("/")[1:2] == ["config"]
        )
        parts["config" if is_config else "code"].update(f"{path}\0{digest}\0".encode())
    return {part: digest.hexdigest() for part, digest in parts.items()}


def remove_stale_entries(root, previous, current):
    """Delete from `root` the entries in `previous` that `current` lacks or has as the
    other kind, deepest first. A directory goes only when empty and a file never where
    a directory now is, so files the container generated stay. Raises ValueError for a
    path whose parent crosses a symlink."""
    root = os.path.realpath(root)
    stale = [path for path, kind in previous.items() if current.get(path) != kind]
    for relative in sorted(stale, key=lambda path: path.count("/"), reverse=True):
        parts = relative.split("/")
        parent = os.path.join(root, *parts[:-1])
        if os.path.realpath(parent) != parent:
            raise ValueError(f"Stale workspace path crosses a symlink: {relative!r}")
        target = os.path.join(parent, parts[-1])
        if previous[relative] == "directory":
            try:
                os.rmdir(target)
            except OSError as error:
                if error.errno not in (
                    errno.ENOENT,
                    errno.ENOTEMPTY,
                    errno.EEXIST,
                    errno.ENOTDIR,
                ):
                    raise
        else:
            with suppress(FileNotFoundError):
                if not os.path.isdir(target) or os.path.islink(target):
                    os.unlink(target)
