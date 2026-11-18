# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos sync`: upload a deployment to the Global Controller container's
/workspace volume: its `deployment.yaml` and the `.env` beside it, and each project's
folder, with the `.env` in it, as one gzip tar per project; then wait for the
container to apply them to the running deploy.

Files live inside the container's named volume (see `init.py`), not on a live
bind mount, so host-side edits don't reach a running build. The container removes
the files the last upload had and this one lacks, and keeps the ones it made.
"""

import contextlib
import os
import tarfile
import tempfile
import time
from pathlib import Path

from canyonos import deployment, ui
from canyonos.auth import machine_api_key
from canyonos.constants import (
    DEPLOYMENT_CONFIG,
    container_path,
    project_env_path,
    project_folder,
)
from canyonos.gc import (
    GCError,
    NoDeployError,
    deploy_status,
    put_deployment,
    put_project,
    require_state,
)
from canyonos.init import load_state

ENV_NAME = ".env"


def project_archive(folder):
    """Return a temporary file, deleted once closed, holding a gzip tar of the project
    in `folder`, with the `.env` in its folder as `.env`. A `.env` that is a link is
    stored as the file it points at."""
    root = os.path.abspath(project_folder(folder))
    buffer = tempfile.TemporaryFile()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for directory, dirnames, filenames in os.walk(root, followlinks=False):
            for entry in dirnames + filenames:
                path = os.path.join(directory, entry)
                relative = container_path(os.path.relpath(path, root))
                if relative != ENV_NAME:
                    archive.add(path, relative, recursive=False)
        env_path = project_env_path(folder)
        if os.path.isfile(env_path):
            with open(env_path, "rb") as env_file:
                info = archive.gettarinfo(arcname=ENV_NAME, fileobj=env_file)
                archive.addfile(info, env_file)
    buffer.seek(0)
    return buffer


def _wait_for_apply(state, generation):
    """Poll the Global Controller's /deployment until it has applied `generation`, and
    return that answer; raise GCError when that apply failed or the container stops
    answering."""
    misses = 0
    while misses < 2:
        status = deploy_status(state)
        misses = 0 if status else misses + 1
        if status and status["applied_generation"] >= generation:
            last_apply = status["last_apply"]
            if not last_apply["ok"]:
                raise GCError(last_apply["error"], error_code=last_apply["code"])
            return status
        time.sleep(1)
    raise GCError("Could not reach Global Controller container.")


def run_sync(projects, keep_other_projects=False, api_key_hash=None):
    """Upload the deployment to the Global Controller container: `deployment.yaml` and
    the `.env` beside it, `api_key_hash` when a deploy gives it, and each of `projects`
    (name to folder) with the `.env` in its folder, printing the container's warnings
    about them; then wait until it has applied them. A project the container holds but
    `projects` leaves out is removed, unless `keep_other_projects`. Returns its
    /deployment answer then, or False when a file could not be read."""
    state = require_state()
    label = f"Syncing {', '.join(projects)}"
    warnings = []
    try:
        with ui.status(f"{label}..."), contextlib.ExitStack() as archives:
            try:
                env = (
                    Path(ENV_NAME).read_text("utf-8")
                    if os.path.isfile(ENV_NAME)
                    else None
                )
                config = Path(DEPLOYMENT_CONFIG).read_text("utf-8")
                # Built first: a gap between uploads would let the container apply some.
                tars = {
                    name: archives.enter_context(project_archive(folder))
                    for name, folder in projects.items()
                }
            except OSError as e:
                ui.fail(str(e))
                return False
            answer = put_deployment(
                state,
                config,
                env,
                None if keep_other_projects else list(projects),
                api_key_hash,
            )
            warnings += answer["warnings"]
            for name, tar in tars.items():
                answer = put_project(state, name, tar)
                warnings += answer["warnings"]
            for warning in warnings:
                ui.warn(warning)
            status = _wait_for_apply(state, answer["generation"])
    except GCError as e:
        if not e.findings:
            raise
        for warning in [*warnings, *e.warnings]:
            ui.warn(warning)
        for finding in e.findings:
            ui.fail(finding)
            ui.blank()
        ui.fail(f"{len(e.findings)} error(s).")
        raise GCError(
            "Fix the project errors `canyonos validate` reports, then rerun.",
            error_code=e.error_code,
        ) from None
    ui.ok("Sync complete.")
    return status


def run_sync_and_reload(folders):
    """Run `canyonos sync`: upload the deployment's config and the projects in
    `folders`, leaving its other projects as they are, then have the Global Controller
    apply them: start, reload or restart the deploy. Returns True once applied, or when no
    Global Controller container runs; raises GCError when applying fails."""
    try:
        state = load_state()
    except FileNotFoundError:
        ui.say("No deploy running; changes apply on the next `canyonos deploy`.")
        return True
    if deploy_status(state) is None:
        raise NoDeployError(
            "Nothing is running for this project. Run `canyonos stop` to clean up."
        )
    status = run_sync(deployment.projects(folders), keep_other_projects=True)
    if not status:
        return False
    action = ui.json_result["action"] = status["last_apply"]["action"]
    if action == "reload":
        ui.ok("Config reloaded.")
    elif action == "none":
        ui.say("Nothing changed.")
    else:
        # Imported here, since deploy imports this module.
        from canyonos.deploy import _watch_deploy

        _watch_deploy(state, serve=False, verbose=False, key=machine_api_key())
    return True
