# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
The record of each workflow group on this machine: `~/.canyonos/workflows/<workflow
group>/`, which holds its `workflow_group.yaml`, each workflow's `<workflow>/config/`,
the state of its last deploy and its CA. `canyonos deploy` reads and writes the workflow group's settings there, never in the
folder it runs from, so a workflow group is redeployed from any folder.

A workflow group is a name: `--workflow-group <name>` deploys into the recorded one of
that name, or makes it. Giving a recorded one other folders replaces its workflows,
after asking. Without a name, a deploy finds its workflow group by the workflow folders
it is given: the record whose `workflows:` lists exactly those folders, by absolute
path; else it makes one named after them. A new record starts from the
`workflow_group.yaml` of the folder the deploy runs from when there is one.

A workflow's `config/` is copied into the record on its first deploy, and the record's
copy is deployed from then on, with the code in the workflow's folder. `validate` and
`convert` still work on the folder.

Every command then runs from the record's folder (`enter`), as if typed there; the
folders it was given are absolute by then.
"""

import hashlib
import os
import shutil
import tempfile

from canyonos import deployment, ui
from canyonos.constants import (
    DEPLOYMENT_CONFIG,
    deployment_config_path,
    load_yaml,
    read_config,
    round_trip_yaml,
    workflow_folder,
    write_config,
)
from canyonos.usage.consent import is_interactive
from utils.tui import select_menu


def _config(name):
    """The `workflow_group.yaml` of record `name`, loaded, or {}."""
    config = read_config(
        os.path.join(deployment.deployments_dir(), name, DEPLOYMENT_CONFIG)
    )
    return config if isinstance(config, dict) else {}


def names():
    """The name of every workflow group recorded on this machine."""
    try:
        entries = sorted(os.listdir(deployment.deployments_dir()))
    except FileNotFoundError:
        return []
    return [
        name
        for name in entries
        if not name.startswith(".")
        and any(
            os.path.isfile(os.path.join(deployment.deployments_dir(), name, file))
            for file in (DEPLOYMENT_CONFIG, "state.json")
        )
    ]


def workflow_paths(name):
    """The absolute folder of each workflow record `name` lists."""
    workflows = _config(name).get("workflows") or {}
    return {
        os.path.abspath(entry["path"])
        for entry in workflows.values()
        if isinstance(entry, dict) and entry.get("path")
    }


def workflows(name):
    """Each workflow record `name` lists: its name, workflow_id and absolute folder."""
    entries = _config(name).get("workflows") or {}
    return [
        {
            "name": workflow,
            "workflow_id": entry.get("workflow_id"),
            "path": os.path.abspath(entry["path"]),
        }
        for workflow, entry in entries.items()
        if isinstance(entry, dict) and entry.get("path")
    ]


def target(name):
    """The `target` record `name` deploys to: docker without one, None when its config
    names no target CanyonOS knows or can't be read."""
    try:
        return deployment.configured_target(
            os.path.join(deployment.deployments_dir(), name, DEPLOYMENT_CONFIG)
        )
    except RuntimeError:
        return None


def _by_id(workflow_group_id):
    """The record of the workflow group `workflow_group_id`, or None."""
    for name in names():
        if _config(name).get("workflow_group_id") == workflow_group_id:
            return name
    return None


def _by_paths(paths):
    """The record whose workflows are exactly the folders `paths`, or None."""
    for name in names():
        if workflow_paths(name) == paths:
            return name
    return None


def _matches(ref):
    """The records `ref` names: by name, with or without the start of its ID, by
    workflow_group_id, else by the start of one."""
    refs = {ref, deployment.normalise(ref)}
    matches = [
        name
        for name in names()
        if refs & {name, name.rsplit("-", 1)[0], _config(name).get("workflow_group_id")}
    ]
    return matches or [
        name
        for name in names()
        if str(_config(name).get("workflow_group_id") or "").startswith(ref)
    ]


def resolve(ref, missing_ok=False):
    """The record `ref` names (see `_matches`). Raises when it names several, and when it
    names none, unless `missing_ok`: then None."""
    matches = _matches(ref)
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        raise RuntimeError(
            f"`{ref}` matches {len(matches)} workflow groups ({', '.join(matches)}); "
            "name one by its ID."
        )
    if missing_ok:
        return None
    raise RuntimeError(
        f"No workflow group is named `{ref}` or has an ID starting with it. See them "
        "with `canyonos list`."
    )


def matching_cwd():
    """The records the folder the command runs from belongs to: one of their workflow
    folders, a folder inside one, or a folder that holds one."""
    here = os.path.abspath(os.getcwd())

    def related(path):
        return here == path or _inside(here, path) or _inside(path, here)

    return [name for name in names() if any(map(related, workflow_paths(name)))]


def _inside(path, folder):
    return path.startswith(folder.rstrip(os.sep) + os.sep)


def enter(name):
    """Run the rest of the command from record `name`'s folder."""
    os.chdir(os.path.join(deployment.deployments_dir(), name))


def _seed():
    """The `workflow_group.yaml` of the folder the command runs from, which a new record
    starts from, or None. Raises when it is still under its old name."""
    path = os.path.abspath(deployment_config_path())
    return path if os.path.isfile(path) else None


def _create(seed, folders, name=None):
    """Make the record of a new workflow group for the workflow `folders`, starting from
    the `workflow_group.yaml` at `seed`, keeping its workflow_group_id unless another
    record has it, and the `.env` beside it (readable only by you), or from the
    starter's. The workflow group is called `name`, by default the seed's folder's name,
    else the first workflow's. The records an older CLI kept for that workflow group
    under `~/.canyonos/deployments/` move into it. Returns its record's name; raises,
    leaving no record, when a folder is no workflow."""
    # Imported here: deploy imports this module.
    from canyonos.deploy import require_deployment_id, save_deployment_config

    if seed:
        require_deployment_id(seed)
    base = name or os.path.basename(os.path.dirname(seed) if seed else folders[0])
    # Its own staging folder: two deploys may make records at once.
    os.makedirs(deployment.deployments_dir(), exist_ok=True)
    staging = tempfile.mkdtemp(prefix=".new-", dir=deployment.deployments_dir())
    config_path = os.path.join(staging, DEPLOYMENT_CONFIG)
    if seed:
        shutil.copyfile(seed, config_path)
        _absolute_workflow_paths(config_path, os.path.dirname(seed))
        if _by_id(read_config(seed).get("workflow_group_id")):
            # Another workflow group started from this seed: this one gets its own ID.
            _drop_workflow_group_id(config_path)
        seed_env = os.path.join(os.path.dirname(seed), ".env")
        if os.path.isfile(seed_env):
            record_env = os.path.join(staging, ".env")
            shutil.copyfile(seed_env, record_env)
            os.chmod(record_env, 0o600)
    save_deployment_config(config_path)
    workflow_group_id = read_config(config_path)["workflow_group_id"]
    name = f"{deployment.normalise(base)}-{workflow_group_id[:8]}"
    record = os.path.join(deployment.deployments_dir(), name)
    os.rename(staging, record)
    typed_in = os.getcwd()
    enter(name)
    try:
        ids = deployment.workflow_ids(folders)
        named = deployment.workflow_folders(folders, ids)
        deployment.save_workflows(DEPLOYMENT_CONFIG, named, ids)
    except BaseException:
        shutil.rmtree(record)
        raise
    finally:
        os.chdir(typed_in)
    legacy = os.path.join(deployment.legacy_deployments_dir(), name)
    if os.path.isdir(legacy):
        for entry in os.listdir(legacy):
            shutil.move(os.path.join(legacy, entry), os.path.join(record, entry))
        os.rmdir(legacy)
    if seed:
        copied = (
            " and the .env beside it"
            if os.path.isfile(os.path.join(record, ".env"))
            else ""
        )
        ui.note(
            f"Workflow group {name} starts from {seed}{copied}; it now lives in {record}"
        )
    return name


def _drop_workflow_group_id(config_path):
    """Remove the `workflow_group_id` of the config at `config_path`."""
    yaml_rt = round_trip_yaml()
    data = load_yaml(config_path, yaml_rt.load)
    if isinstance(data, dict) and data.pop("workflow_group_id", None):
        write_config(config_path, data, yaml_rt)


def _absolute_workflow_paths(config_path, seed_dir):
    """Write each `workflows:` path of the config at `config_path`, relative to
    `seed_dir`, as an absolute path."""
    yaml_rt = round_trip_yaml()
    data = load_yaml(config_path, yaml_rt.load)
    workflows = data.get("workflows") if isinstance(data, dict) else None
    if not isinstance(workflows, dict):
        return
    for entry in workflows.values():
        if isinstance(entry, dict) and entry.get("path"):
            entry["path"] = os.path.abspath(os.path.join(seed_dir, entry["path"]))
    write_config(config_path, data, yaml_rt)


def _confirm_replace(name, old, new, yes):
    """Ask before a deploy replaces workflow group `name`'s workflow folders `old` with
    `new`, stopping the workflows `new` leaves out; True to go on. `yes` answers yes."""
    dropped = sorted(old - new)
    ui.warn(
        f"This replaces the workflows of {name}:\n- "
        + "\n- ".join(
            f"{path}{' (stops)' if path in dropped else ''}" for path in sorted(old)
        )
        + "\nwith:\n- "
        + "\n- ".join(sorted(new))
    )
    if yes:
        return True
    if not is_interactive():
        ui.fail(
            "Replacing a workflow group's workflows asks first. Add --yes to run it without a terminal."
        )
        return False
    answer = select_menu(
        [(True, "Yes, replace them"), (False, "No, keep them")],
        title=f"Replace the workflows of {name}?",
    )
    return answer is True


def enter_for_deploy(folders, ref=None, yes=False):
    """Enter the record `canyonos deploy` acts on, making it when there is none, and
    return the workflow folders to deploy, absolute: `folders`, or with none, those the
    record lists. `ref`, --workflow-group, is a workflow group's name: the recorded one
    it names, else a new one it names. False when the user declined to replace a
    record's workflows."""
    paths = {os.path.abspath(folder) for folder in folders}
    seed = _seed()
    if ref:
        name = resolve(ref, missing_ok=True)
        if name is None and not folders:
            raise RuntimeError(
                f"No workflow group is named `{ref}`. Make it by giving its workflow "
                f"folders: `canyonos deploy <folder>... --workflow-group {ref}`."
            )
        if name is None:
            name = _create(seed, [os.path.abspath(f) for f in folders], name=ref)
            seed = None
    else:
        if not folders:
            raise RuntimeError(
                "Name the workflow folders to deploy, or the workflow group to "
                "redeploy with --workflow-group."
            )
        seed_id = read_config(seed).get("workflow_group_id") if seed else None
        name = (seed_id and _by_id(seed_id)) or _by_paths(paths)
    if name is None:
        name = _create(seed, [os.path.abspath(folder) for folder in folders])
    elif seed:
        ui.note(
            f"Deploying {name} as {os.path.join(deployment.deployments_dir(), name, DEPLOYMENT_CONFIG)} "
            f"sets it; {seed} is not read."
        )
    recorded = workflow_paths(name)
    if not folders:
        if not recorded:
            raise RuntimeError(
                f"{name} records no workflow folder: name the ones to deploy."
            )
        folders = sorted(recorded)
    elif (
        recorded
        and recorded != paths
        and not _confirm_replace(name, recorded, paths, yes)
    ):
        return False
    folders = [os.path.abspath(folder) for folder in folders]
    enter(name)
    return folders


def pick(here, selected):
    """The record a command that names none acts on: the only one of `here`, the records
    the folder it runs from belongs to, else `selected`, the `select-context` pick (a
    name, or None), when it is one of them or there are none; None when there is none.
    Raises when the folder belongs to several and the pick is none of them."""
    if len(here) == 1:
        return here[0]
    if selected is not None and (not here or selected in here):
        return selected
    if here:
        raise RuntimeError(
            f"This folder belongs to {len(here)} workflow groups ({', '.join(here)}): "
            "name one, or pick one with `canyonos select-context <workflow group>`."
        )
    return None


def enter_for_command(selected):
    """Enter the record `pick` picks for the folder the command runs from and
    `selected`, and return its name; leave the folder as it is when there is none."""
    picked = pick(matching_cwd(), selected)
    if picked is not None:
        enter(picked)
    return picked


def workflow_config_dir(name):
    """The `config/` the record of the workflow group this command acts on keeps for its
    workflow `name`: the one a deploy uploads, whether or not it is there yet."""
    return os.path.join(deployment.state_dir(), name, "config")


def import_workflow_configs(workflows, prune=True):
    """Give each of `workflows` (name to folder) its `config/` in the record, copied
    from the workflow's own folder until a deploy of it has gone through
    (`mark_deployed`); from then on the record's copy is the one deployed, and a
    folder `config/` changed since is only reported. With `prune`, remove the copies
    of workflows the workflow group no longer has."""
    for name, folder in workflows.items():
        source = os.path.join(workflow_folder(folder), "config")
        kept = workflow_config_dir(name)
        stamp = _stamp_path(name)
        if not os.path.isfile(stamp) and os.path.isdir(source):
            shutil.rmtree(kept, ignore_errors=True)
            shutil.copytree(source, kept)
            ui.note(f"{name}'s config now lives in {kept}; edit it there.")
        elif os.path.isdir(source) and _read(stamp) != _fingerprint(source):
            ui.warn(
                f"{source} changed since {name} was first deployed, so it is not "
                f"deployed: {kept} is. Edit that one."
            )
    if not prune:
        return
    for entry in os.listdir(deployment.state_dir()):
        config = os.path.join(deployment.state_dir(), entry, "config")
        if entry not in workflows and os.path.isdir(config):
            shutil.rmtree(os.path.join(deployment.state_dir(), entry))


def mark_deployed(workflows):
    """Note that `workflows` (name to folder) deployed with their record's `config/`,
    so it is no longer replaced from their folders: keep the fingerprint of each
    folder's `config/` as it is now, the one later changes are told against."""
    for name, folder in workflows.items():
        stamp = _stamp_path(name)
        if os.path.isfile(stamp):
            continue
        source = os.path.join(workflow_folder(folder), "config")
        with open(stamp, "w", encoding="utf-8") as f:
            f.write(_fingerprint(source) if os.path.isdir(source) else "")


def _stamp_path(name):
    """Where the record keeps the fingerprint of workflow `name`'s folder `config/`
    as of its first deploy."""
    return os.path.join(
        os.path.dirname(workflow_config_dir(name)), "deployed-from.sha256"
    )


def _read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def _fingerprint(folder):
    """A SHA-256 of every file under `folder`, by its path in it."""
    digest = hashlib.sha256()
    for directory, dirnames, filenames in sorted(os.walk(folder)):
        dirnames.sort()
        for filename in sorted(filenames):
            path = os.path.join(directory, filename)
            digest.update(os.path.relpath(path, folder).encode() + b"\0")
            with open(path, "rb") as f:
                digest.update(f.read() + b"\0")
    return digest.hexdigest()
