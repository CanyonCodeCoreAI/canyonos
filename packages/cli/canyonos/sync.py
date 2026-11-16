# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos sync`: mirror a deployment into the Global Controller container's
/workspace volume via `docker cp`: its `deployment.yaml` and the `.env` beside it, and
each project's folder, with the `.env` in it, as `/workspace/<project>/`.

Files live inside the container's named volume (see `init.py`), not on a live
bind mount, so host-side edits don't reach a running build. A manifest records
which paths the previous sync managed. Before the next additive `docker cp`,
only managed paths that disappeared from the host are removed; container-side
build artifacts and other untracked workspace files are left alone.
"""

import json
import os
import tempfile

from canyonos import deployment, ui
from canyonos.constants import (
    DEPLOYMENT_CONFIG,
    container_path,
    project_env_path,
    project_folder,
)
from canyonos.docker_cmd import DOCKER_RUN_TIMEOUT, run_docker
from canyonos.gc import GCError, deploy_status, post_reload, require_state
from canyonos.init import GC_WORKSPACE_PATH, load_state
from canyonos.validate import stop_on_project_errors


_SYNC_STATE_VERSION = 1

# This runs inside the Global Controller container. Paths are deleted deepest
# first, and directories are removed only when empty. That preserves files a
# container-side build may have generated beneath a formerly synced directory.
_DELETE_STALE_SCRIPT = """
import errno
import json
import os
import sys

root = os.path.realpath(sys.argv[1])
manifest_path = sys.argv[2]
try:
    with open(manifest_path, encoding="utf-8") as manifest_file:
        stale_entries = json.load(manifest_file)
    for relative, kind in stale_entries:
        parts = relative.split("/")
        if not relative or any(part in ("", ".", "..") for part in parts):
            raise RuntimeError("unsafe sync manifest path: " + repr(relative))
        unresolved_parent = os.path.join(root, *parts[:-1])
        parent = os.path.realpath(unresolved_parent)
        if parent != os.path.abspath(unresolved_parent):
            raise RuntimeError("sync manifest path crosses a symlink: " + repr(relative))
        if os.path.commonpath((root, parent)) != root:
            raise RuntimeError("sync manifest path escapes workspace: " + repr(relative))
        target = os.path.join(parent, parts[-1])
        if kind == "directory":
            try:
                os.rmdir(target)
            except FileNotFoundError:
                pass
            except OSError as error:
                if error.errno not in (errno.ENOTEMPTY, errno.EEXIST, errno.ENOTDIR):
                    raise
        else:
            try:
                if not os.path.isdir(target) or os.path.islink(target):
                    os.unlink(target)
            except FileNotFoundError:
                pass
finally:
    try:
        os.unlink(manifest_path)
    except FileNotFoundError:
        pass
"""


ENV_NAME = ".env"


def _project_entries(project_root, env_path):
    """Return the relative paths and types a sync copies of one project: everything
    under its root, and `.env` when `env_path` is a file."""
    entries = {}
    for directory, dirnames, filenames in os.walk(project_root, followlinks=False):
        for name in dirnames + filenames:
            path = os.path.join(directory, name)
            relative = container_path(os.path.relpath(path, project_root))
            entries[relative] = (
                "directory"
                if os.path.isdir(path) and not os.path.islink(path)
                else "entry"
            )
    if os.path.isfile(env_path):
        entries[ENV_NAME] = "entry"
    return entries


def _deployment_entries(projects):
    """Return the paths, relative to `/workspace`, and types a sync copies of the
    deployment: `deployment.yaml`, the `.env` beside it, and each project's entries
    under `<project>/`. `projects` maps each project's name to its folder."""
    entries = {DEPLOYMENT_CONFIG: "entry"}
    if os.path.isfile(ENV_NAME):
        entries[ENV_NAME] = "entry"
    for name, folder in projects.items():
        entries[name] = "directory"
        project_entries = _project_entries(
            project_folder(folder), project_env_path(folder)
        )
        for relative, kind in project_entries.items():
            entries[f"{name}/{relative}"] = kind
    return entries


# The manifest only records what the last sync copied, so discarding it costs
# nothing beyond skipping stale-file removal on the next run.
_MANIFEST_RECOVERY_HINT = "Move or remove that file, then run `canyonos deploy` again."


def _previous_entries(container_id):
    """Return the project files the last sync copied into this container, from the list
    saved under `~/.canyonos`; empty if it was never synced."""
    manifest_path = deployment.sync_manifest_path()
    try:
        with open(manifest_path, encoding="utf-8") as manifest_file:
            manifest = json.load(manifest_file)
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(
            f"Could not read the sync manifest at {manifest_path}: {error}. "
            f"{_MANIFEST_RECOVERY_HINT}"
        ) from None

    if not isinstance(manifest, dict):
        raise RuntimeError(
            f"The sync manifest at {manifest_path} is invalid. {_MANIFEST_RECOVERY_HINT}"
        )

    if manifest.get("container_id") != container_id:
        return {}

    entries = manifest.get("entries")
    if (
        manifest.get("version") != _SYNC_STATE_VERSION
        or not isinstance(entries, dict)
        or any(
            not isinstance(path, str)
            or not path
            or path.startswith("/")
            or any(part in ("", ".", "..") for part in path.split("/"))
            or kind not in {"directory", "entry"}
            for path, kind in entries.items()
        )
    ):
        raise RuntimeError(
            f"The sync manifest at {manifest_path} is invalid. {_MANIFEST_RECOVERY_HINT}"
        )
    return entries


def _stale_entries(previous, current):
    stale = [
        (path, kind) for path, kind in previous.items() if current.get(path) != kind
    ]
    return sorted(stale, key=lambda item: item[0].count("/"), reverse=True)


def _remove_stale_entries(container_id, stale_entries):
    """Delete from the container's workspace the files synced before that are no longer
    in the project."""
    if not stale_entries:
        return

    local_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            prefix="canyonos-sync-stale-",
            suffix=".json",
            delete=False,
        ) as manifest_file:
            local_path = manifest_file.name
            json.dump(stale_entries, manifest_file)

        remote_path = f"/tmp/{os.path.basename(local_path)}"
        copied = run_docker(
            ["docker", "cp", local_path, f"{container_id}:{remote_path}"],
            timeout=DOCKER_RUN_TIMEOUT,
            action="Preparing stale project file cleanup",
        )
        if copied.returncode != 0:
            detail = copied.stderr.strip() or copied.stdout.strip()
            raise RuntimeError(
                f"Could not prepare stale project file cleanup: {detail}"
            )

        removed = run_docker(
            [
                "docker",
                "exec",
                container_id,
                "python",
                "-c",
                _DELETE_STALE_SCRIPT,
                GC_WORKSPACE_PATH,
                remote_path,
            ],
            timeout=DOCKER_RUN_TIMEOUT,
            action="Removing stale project files",
        )
        if removed.returncode != 0:
            detail = removed.stderr.strip() or removed.stdout.strip()
            raise RuntimeError(f"Could not remove stale project files: {detail}")
    finally:
        if local_path is not None:
            try:
                os.remove(local_path)
            except FileNotFoundError:
                pass


def _save_sync_state(container_id, entries):
    """Save a list, in a file under `~/.canyonos`, of the project files just copied into
    the container, so the next sync can tell which ones you've deleted since."""
    manifest_path = deployment.sync_manifest_path()
    os.makedirs(os.path.dirname(manifest_path), exist_ok=True)
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=os.path.dirname(manifest_path),
            prefix="sync-manifest.",
            suffix=".tmp",
            delete=False,
        ) as manifest_file:
            temporary_path = manifest_file.name
            json.dump(
                {
                    "version": _SYNC_STATE_VERSION,
                    "container_id": container_id,
                    "entries": entries,
                },
                manifest_file,
                sort_keys=True,
            )
            manifest_file.flush()
            os.fsync(manifest_file.fileno())
        os.replace(temporary_path, manifest_path)
    except Exception:
        if temporary_path is not None:
            try:
                os.remove(temporary_path)
            except FileNotFoundError:
                pass
        raise


def _copy(source, container_id, destination, action, follow_link=False):
    """Copy `source` on this machine to `destination` in the container, the file a
    symbolic link `source` points at when `follow_link`; raise with docker's own
    message when it fails."""
    flags = ["-L"] if follow_link else []
    result = run_docker(
        ["docker", "cp", *flags, source, f"{container_id}:{destination}"],
        timeout=DOCKER_RUN_TIMEOUT,
        action=action,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Sync failed: {result.stderr.strip() or result.stdout.strip()}"
        )


def run_sync(projects, keep_other_projects=False):
    """Copy the deployment into the Global Controller container: `deployment.yaml` and
    the `.env` beside it, and each of `projects` (name to folder) with the `.env` in
    its folder. A project the container holds but `projects` leaves out is removed,
    unless `keep_other_projects`. Returns True on success."""
    state = require_state()
    if state is None:
        return False

    container_id = state["container_id"]
    label = f"Syncing {', '.join(projects)} -> {container_id[:12]}:{GC_WORKSPACE_PATH}"

    with ui.status(f"{label}..."):
        # Captured so docker's own progress output doesn't clobber the spinner.
        try:
            previous = _previous_entries(container_id)
            entries = _deployment_entries(projects)
            if keep_other_projects:
                # Every path but the deployment's own files is under its project's name.
                entries = {
                    **{
                        path: kind
                        for path, kind in previous.items()
                        if path not in (DEPLOYMENT_CONFIG, ENV_NAME)
                        and path.split("/")[0] not in projects
                    },
                    **entries,
                }
            stale_entries = _stale_entries(previous, entries)
            _remove_stale_entries(container_id, stale_entries)
            _copy(
                DEPLOYMENT_CONFIG,
                container_id,
                f"{GC_WORKSPACE_PATH}/{DEPLOYMENT_CONFIG}",
                f"Syncing {DEPLOYMENT_CONFIG}",
            )
            if os.path.isfile(ENV_NAME):
                _copy(
                    ENV_NAME,
                    container_id,
                    f"{GC_WORKSPACE_PATH}/{ENV_NAME}",
                    "Syncing the deployment's .env",
                    follow_link=True,
                )
            for name, folder in projects.items():
                root = os.path.abspath(project_folder(folder))
                # Trailing "/." copies the *contents* of root into the project's folder.
                _copy(
                    os.path.join(root, "."),
                    container_id,
                    f"{GC_WORKSPACE_PATH}/{name}",
                    f"Syncing {name}'s files",
                )
                env_path = os.path.abspath(project_env_path(folder))
                if os.path.dirname(env_path) != root and os.path.isfile(env_path):
                    _copy(
                        env_path,
                        container_id,
                        f"{GC_WORKSPACE_PATH}/{name}/{ENV_NAME}",
                        f"Syncing {name}'s .env",
                        follow_link=True,
                    )
        except (OSError, RuntimeError) as e:
            ui.fail(str(e))
            return False

    try:
        _save_sync_state(container_id, entries)
    except OSError as e:
        ui.fail(
            f"Could not save the sync manifest at {deployment.sync_manifest_path()}: {e}"
        )
        return False

    ui.ok("Sync complete.")
    return True


def run_sync_and_reload(folders):
    """Run `canyonos sync`: copy the projects in `folders` into the container, leaving
    the deployment's other projects as they are, then have the running deploy reload
    its config. Returns True on success, or when no deploy is
    running."""
    try:
        state = load_state()
    except FileNotFoundError:
        state = None
    status = deploy_status(state["port"]) if state else {}
    if status is None:
        ui.fail("Nothing is running for this project. Run `canyonos stop` to clean up.")
        return False
    if not status.get("running"):
        ui.say("No deploy running; changes apply on the next `canyonos deploy`.")
        return True
    projects = deployment.projects(folders)
    # Copied in first and checked by the reload after, a broken file would stay in the
    # deployment's workspace.
    for folder in projects.values():
        stop_on_project_errors(folder, "Sync")
    if not run_sync(projects, keep_other_projects=True):
        return False
    try:
        post_reload(state["port"])
    except GCError as e:
        ui.fail(e)
        return False
    # A reload applies the config; synced code waits for the next deploy.
    ui.ok("Controller received the reload; see `canyonos logs` for the result.")
    return True
