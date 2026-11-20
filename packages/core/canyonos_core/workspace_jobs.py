# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The changes the CanyonOS API makes to a Docker workflow group's workspace, each run
as a `canyonos_core.cli` command in a one-off container of the core image that mounts
the workspace volume at `/workspace`: unpack an uploaded workflow once it passes
`canyonos validate`, remove workflows, and write `workflow_group.yaml` and its `.env`.
The CanyonOS API puts each command's input under `/tmp` of that container."""

import json
import os
import sys
import tarfile
import tempfile

from canyonos_core.controller.utils.config_env import read_dotenv
from canyonos_core.graph import build_graph
from canyonos_core.schema import CONFIG_PATH, DEPLOYMENT_CONFIG
from canyonos_core.validate import ManifestNotFound, finding_text, validate_root
from canyonos_core.workspace_upload import (
    archive_digests,
    archive_entries,
    remove_stale_entries,
)

# What each workflow's last upload put in the workspace, by path, so the next upload
# or a removal deletes only that. A dot folder: no workflow can be named so.
ENTRIES_DIR = os.path.join(".canyonos", "entries")
# Where the CanyonOS API puts `write-group-files`' input.
GROUP_FILES_REQUEST = "/tmp/group.json"


class CommandError(Exception):
    """A command that failed: its message and `fields` are what it shows on stdout, as
    one JSON object, and `exit_code` is what `canyonos_core.cli` exits with."""

    def __init__(self, message, exit_code=1, **fields):
        super().__init__(message)
        self.exit_code = exit_code
        self.fields = fields


def _check_name(name, **fields):
    """Raise CommandError, with `fields`, unless `name` can be a workflow's folder in
    the workspace."""
    if not name or "/" in name or name.startswith("."):
        raise CommandError(f"{name!r} is not a workflow name.", **fields)


def _entries_file(workspace, name):
    """The path of the file that keeps what workflow `name`'s last upload put in
    `workspace`."""
    return os.path.join(workspace, ENTRIES_DIR, f"{name}.json")


def _read_entries(workspace, name):
    """Return what workflow `name`'s last upload put in `workspace`, by path, or None
    when it was never uploaded."""
    try:
        with open(_entries_file(workspace, name), encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return None


def _write_entries(workspace, name, entries):
    """Keep `entries` as what workflow `name`'s upload put in `workspace`, replacing the
    file all at once."""
    path = _entries_file(workspace, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(f"{path}.tmp", "w", encoding="utf-8") as f:
        json.dump(entries, f)
    os.replace(f"{path}.tmp", path)


def put_workflow(workspace, name, archive_path):
    """Check the gzip tar of workflow `name` at `archive_path` as `canyonos validate`
    does, then unpack it into `workspace/<name>`, removing what its last upload had and
    this one lacks. Return its files' digests, keyed `<name>/<path>`, a warning when its
    `.env` lacks values its `.env.example` names, its test query, and its agent graph
    (graph.py), null when it can't be read. On a bad archive, an unsafe path or
    findings, raise CommandError and leave the old files in place."""
    _check_name(name, code="workflow_invalid", findings=[], warnings=[])
    workflow_dir = os.path.join(workspace, name)
    try:
        # nosemgrep: trailofbits.python.tarfile-extractall-traversal.tarfile-extractall-traversal
        with tarfile.open(archive_path, mode="r:gz") as archive:
            members = archive.getmembers()
            entries = archive_entries(members)
            digests = archive_digests(archive, members)
            with tempfile.TemporaryDirectory() as checked:
                archive.extractall(checked, members, filter="tar")
                warnings = _env_warnings(checked, name)
                _validate(checked, name, warnings)
                graph = _graph(checked, name)
            previous = _read_entries(workspace, name) or {}
            # Kept first with both uploads' entries, so an unpack cut short is still
            # cleaned up by the next upload.
            _write_entries(workspace, name, {**previous, **entries})
            remove_stale_entries(workflow_dir, previous, entries)
            archive.extractall(workflow_dir, members, filter="tar")
            _write_entries(workspace, name, entries)
    except (tarfile.TarError, EOFError, OSError, ValueError) as e:
        raise CommandError(
            f"Could not unpack the workflow: {e}",
            code="bad_archive",
            findings=[],
            warnings=[],
        ) from None
    return {
        "digests": {
            f"{name}/{relative}": digest for relative, digest in digests.items()
        },
        "warnings": warnings,
        "test_query": _test_query(workflow_dir),
        "graph": graph,
    }


def _graph(workflow_dir, name):
    """Workflow `name`'s agent graph, read from `workflow_dir`, or None when reading it
    fails: the graph only describes the workflow, so it never refuses an upload."""
    try:
        return build_graph(workflow_dir, name)
    except Exception as e:  # noqa: BLE001 - any failure here leaves the upload as is
        print(f"Could not read {name}'s agent graph: {e!r}", file=sys.stderr)
        return None


def _env_warnings(workflow_dir, name):
    """Warn when the `.env` in `workflow_dir` lacks a value for a key its
    `.env.example` names; agents that need one fail."""
    values = read_dotenv(os.path.join(workflow_dir, ".env"))
    unset = [
        key
        for key in read_dotenv(os.path.join(workflow_dir, ".env.example"))
        if not values.get(key)
    ]
    if not unset:
        return []
    return [
        f"Missing or empty in {name}/.env: {', '.join(unset)}. Agents that need them "
        "will fail."
    ]


def _validate(workflow_dir, name, warnings):
    """Raise CommandError with every finding `canyonos validate` reports for workflow
    `name`, unpacked in `workflow_dir`, and `warnings`, unless it has none."""
    try:
        findings = [
            finding_text(finding._replace(path=os.path.join(name, finding.path)))
            for finding in validate_root(workflow_dir)
        ]
    except ManifestNotFound:
        findings = [f"{name}/{CONFIG_PATH} is missing, so nothing was checked."]
    if findings:
        raise CommandError(
            f"{name} was not uploaded: fix the errors `canyonos validate` reports, "
            "then rerun.",
            code="workflow_invalid",
            findings=findings,
            warnings=warnings,
        )


def _test_query(workflow_dir):
    """Return the query in the workflow's `config/test_query.txt`, or None when it has
    none."""
    try:
        with open(
            os.path.join(workflow_dir, "config", "test_query.txt"), encoding="utf-8"
        ) as f:
            return f.read().strip() or None
    except OSError:
        return None


def remove_workflows(workspace, names):
    """Remove from `workspace` what each workflow in `names` had its last upload put
    there, and forget that upload; files the deploy generated stay. Return the names
    that were uploaded and are now removed; raise CommandError when one can't be."""
    removed = []
    for name in names:
        _check_name(name)
        try:
            entries = _read_entries(workspace, name)
            if entries is None:
                continue
            remove_stale_entries(os.path.join(workspace, name), entries, {})
            os.remove(_entries_file(workspace, name))
        except (OSError, ValueError) as e:
            raise CommandError(f"Could not remove workflow {name}: {e}") from None
        removed.append(name)
    return {"removed": removed}


def write_group_files(workspace, request_path=GROUP_FILES_REQUEST):
    """Write `workflow_group.yaml` into `workspace` from the `config` text in the JSON
    at `request_path`, and its `.env` from `env`, removing that `.env` when `env` is
    null. Raise CommandError when the request can't be read or a file can't be
    written."""
    try:
        with open(request_path, encoding="utf-8") as f:
            request = json.load(f)
    except (OSError, ValueError) as e:
        raise CommandError(f"Could not read {request_path}: {e}") from None
    config = request.get("config") if isinstance(request, dict) else None
    env = request.get("env") if isinstance(request, dict) else None
    if not isinstance(config, str) or not (env is None or isinstance(env, str)):
        raise CommandError(
            f"{request_path} must hold a `config` text and an `env` text or null."
        )
    try:
        for file, text in {DEPLOYMENT_CONFIG: config, ".env": env}.items():
            path = os.path.join(workspace, file)
            if text is None:
                if os.path.lexists(path):
                    os.remove(path)
                continue
            # Replaced all at once: the running deploy reads it for status and reloads.
            with open(f"{path}.tmp", "w", encoding="utf-8") as f:
                f.write(text)
            os.replace(f"{path}.tmp", path)
    except OSError as e:
        raise CommandError(f"Could not write the workflow group's files: {e}") from None
    return {"ok": True}
