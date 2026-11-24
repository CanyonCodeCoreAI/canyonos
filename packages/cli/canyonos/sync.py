# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos sync`: upload a workflow group through the CanyonOS API to its
Global Controller container's /workspace volume: its `workflow_group.yaml` and the
`.env` beside it, and each workflow's folder, with the `.env` in it, as one gzip tar
per workflow; then wait for the API to apply them to the deploy.

Files live inside the container's named volume (see `init.py`), not on a live
bind mount, so host-side edits don't reach a running build. The API removes
the files the last upload had and this one lacks, and keeps the ones it made.
"""

import contextlib
import os
import tarfile
import tempfile
import time
from pathlib import Path

import yaml

from canyonos import deployment, env, records, ui
from canyonos.api import (
    ApiError,
    NoDeployError,
    deploy_status,
    put_workflow,
    put_workflow_group,
    require_state,
    workflow_group_status,
)
from canyonos.auth import group_api_key
from canyonos.constants import (
    DEPLOYMENT_CONFIG,
    container_path,
    workflow_env_path,
    workflow_folder,
)
from canyonos.init import load_state

ENV_NAME = ".env"
# Lists the keys a workflow needs, without values; the upload's check warns about the
# ones its `.env` leaves unset.
ENV_EXAMPLE_NAME = ".env.example"
# Left out of every workflow upload, at any depth: git history, virtualenvs, installed
# packages and bytecode, which only this machine uses. Every `.env*` file is left out
# too (`_uploaded`), so no API key leaves this machine but in the `.env` the upload adds
# on purpose; only the `.env.example` at the top of the workflow folder stays in.
UPLOAD_EXCLUDES = (".git", ".venv", "node_modules", "__pycache__")
# The providers that put agents on machines other than this one.
_REMOTE_PROVIDERS = ("ec2-pool", "ec2-assign")


def workflow_archive(name, folder):
    """Return a temporary file, deleted once closed, holding a gzip tar of workflow
    `name`: the code in `folder`, the `config/` the workflow group's record keeps for it
    in place of the folder's own, and the `.env` in its folder as `.env`, leaving out
    what UPLOAD_EXCLUDES names and every other `.env*` file. A `.env` that is a link is
    stored as the file it points at."""
    root = os.path.abspath(workflow_folder(folder))
    config = records.workflow_config_dir(name)
    buffer = tempfile.TemporaryFile()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        _add_tree(archive, root, "", skip=("config",), keep=(ENV_EXAMPLE_NAME,))
        archive.add(config, "config", recursive=False)
        _add_tree(archive, config, "config")
        env_path = workflow_env_path(folder)
        if os.path.isfile(env_path):
            with open(env_path, "rb") as env_file:
                info = archive.gettarinfo(arcname=ENV_NAME, fileobj=env_file)
                archive.addfile(info, env_file)
    buffer.seek(0)
    return buffer


def _uploaded(name):
    """True when a file or folder called `name` goes into a workflow upload: it is not
    one of UPLOAD_EXCLUDES and not a `.env*` file, in any case, since a case-insensitive
    filesystem reads `.ENV` as `.env`."""
    folded = name.casefold()
    return folded not in UPLOAD_EXCLUDES and not folded.startswith(ENV_NAME)


def _add_tree(archive, base, prefix, skip=(), keep=()):
    """Add everything under `base` to `archive` under `prefix`, but what `_uploaded`
    leaves out at any depth and the entries of `base` itself that `skip` names; the
    entries of `base` that `keep` names go in all the same."""

    def added(entry, at_top):
        if at_top and entry in skip:
            return False
        return _uploaded(entry) or (at_top and entry in keep)

    for directory, dirnames, filenames in os.walk(base, followlinks=False):
        at_top = directory == base
        dirnames[:] = [entry for entry in dirnames if added(entry, at_top)]
        filenames = [entry for entry in filenames if added(entry, at_top)]
        for entry in dirnames + filenames:
            path = os.path.join(directory, entry)
            relative = os.path.join(prefix, os.path.relpath(path, base))
            archive.add(path, container_path(relative), recursive=False)


def collector_image_warnings(config_text):
    """Machines other than this one run their metrics collector from the official
    release image; warn when this deploy's Global Controller runs another core image,
    such as a dev build, and `config_text`, the workflow group's config, puts agents
    on such machines."""
    if env.core_image == env.PROD_CORE_IMAGE:
        return []
    try:
        config = yaml.safe_load(config_text)
    except yaml.YAMLError:
        config = None
    provider = config.get("provider") if isinstance(config, dict) else None
    if str(provider or "").casefold() not in _REMOTE_PROVIDERS:
        return []
    return [
        f"Agent machines run the machine metrics collector from {env.PROD_CORE_IMAGE}, "
        f"not {env.core_image}: changes to it here don't reach them, and if "
        f"{env.VERSION} isn't published they report no machine metrics."
    ]


def _wait_for_apply(state, generation):
    """Poll the CanyonOS API's status until it has applied `generation`, and return
    that answer; raise ApiError when that apply failed, including a Global Controller
    that would not start, or the API stops answering."""
    misses = 0
    while misses < 2:
        status = deploy_status(state)
        misses = 0 if status else misses + 1
        if status and status["applied_generation"] >= generation:
            last_apply = status["last_apply"]
            if not last_apply["ok"]:
                raise ApiError(last_apply["error"], code=last_apply["code"])
            return status
        time.sleep(1)
    raise ApiError("Could not reach the CanyonOS API.")


def run_sync(workflows, keep_other_workflows=False, api_key_hash=None):
    """Upload the workflow group through the CanyonOS API: `workflow_group.yaml` and the
    `.env` beside it, `api_key_hash` when a deploy gives it, and each of `workflows`
    (name to folder) with the `.env` in its folder, printing the API's warnings about
    them; then wait until it has applied them. A workflow the API holds but
    `workflows` leaves out is removed, unless `keep_other_workflows`. Returns its
    status then, or False when a file could not be read."""
    state = require_state()
    label = f"Syncing {', '.join(workflows)}"
    ids = {
        name: workflow_id
        for workflow_id, name in deployment.workflow_names_by_id().items()
    }
    warnings = []
    try:
        with ui.status(f"{label}..."), contextlib.ExitStack() as archives:
            try:
                env_text = (
                    Path(ENV_NAME).read_text("utf-8")
                    if os.path.isfile(ENV_NAME)
                    else None
                )
                config = Path(DEPLOYMENT_CONFIG).read_text("utf-8")
                # Built first: a gap between uploads would let the container apply some.
                tars = {
                    name: archives.enter_context(workflow_archive(name, folder))
                    for name, folder in workflows.items()
                }
            except OSError as e:
                ui.fail(str(e))
                return False
            answer = put_workflow_group(
                state,
                config,
                env_text,
                None if keep_other_workflows else [ids[name] for name in workflows],
                api_key_hash,
            )
            warnings += answer["warnings"]
            if deployment.configured_target() != "kubernetes":
                warnings += collector_image_warnings(config)
            for name, tar in tars.items():
                answer = put_workflow(state, ids[name], tar)
                warnings += answer["warnings"]
            for warning in warnings:
                ui.warn(warning)
            status = _wait_for_apply(state, answer["generation"])
    except ApiError as e:
        if not e.findings:
            raise
        for warning in [*warnings, *e.warnings]:
            ui.warn(warning)
        for finding in e.findings:
            ui.fail(finding)
            ui.blank()
        ui.fail(f"{len(e.findings)} error(s).")
        raise ApiError(
            "Fix the workflow errors `canyonos validate` reports, then rerun.",
            code=e.code,
        ) from None
    ui.ok("Sync complete.")
    return status


def run_sync_and_reload(folders):
    """Run `canyonos sync`: upload the workflow group's config and the workflows in
    `folders`, leaving its other workflows as they are, then have the Global Controller
    apply them: start, reload or restart the deploy. Returns True once applied, or when no
    Global Controller container runs; raises ApiError when applying fails."""
    try:
        state = load_state()
    except FileNotFoundError:
        ui.say(
            "No workflow group running; changes apply on the next `canyonos deploy`."
        )
        return True
    if "api_url" not in state:
        # Imported here: serve imports the stack, which this module has no need of.
        from canyonos.serve import ensure_api

        ensure_api()
    if workflow_group_status(state) is None:
        raise NoDeployError(
            "Nothing is running for this workflow group. Run `canyonos stop` to clean up."
        )
    workflows = deployment.workflow_folders(
        folders, deployment.workflow_ids(folders, new=False)
    )
    records.import_workflow_configs(workflows, prune=False)
    status = run_sync(workflows, keep_other_workflows=True)
    if not status:
        return False
    records.mark_deployed(workflows)
    action = ui.json_result["action"] = status["last_apply"]["action"]
    if action == "reload":
        ui.ok("Config reloaded.")
    elif action == "none":
        ui.say("Nothing changed.")
    else:
        # Imported here, since deploy imports this module.
        from canyonos.deploy import _watch_deploy

        _watch_deploy(state, serve=False, verbose=False, key=group_api_key())
    return True
