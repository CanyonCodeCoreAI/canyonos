# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Logic for canyonos clean: remove generated artifacts, skills and the project's
agent images."""

import os
import shutil
import subprocess

import yaml

from canyonos import convert, project, ui
from canyonos.constants import CANYON_DIR, default_config_path


def _project_images():
    """Return the image name of every agent in the project's `global_controller.yaml`,
    or None when the file is missing or can't be read."""
    try:
        with open(default_config_path(), encoding="utf-8") as f:
            config = yaml.safe_load(f) or {}
    except (OSError, yaml.YAMLError):
        return None
    agent_specs = config.get("agents") if isinstance(config, dict) else None
    return [
        project.image_name(agent_spec["name"])
        for agent_spec in agent_specs or []
        if isinstance(agent_spec, dict) and isinstance(agent_spec.get("name"), str)
    ]


def _remove_canyon_images(images):
    """Remove the images CanyonOS built for this project's agents, leaving other
    projects' images and the CanyonOS images themselves in place."""
    if images is None:
        ui.hint(
            f"No readable {default_config_path()} here, so no Docker images were "
            "removed."
        )
        return
    if not images:
        return

    filters = [arg for image in images for arg in ("--filter", f"reference={image}")]
    try:
        result = subprocess.run(
            ["docker", "images", *filters, "-q"],
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except OSError as error:
        ui.warn(f"Could not clean Docker images: {error}")
        return

    if result.returncode != 0:
        detail = result.stderr.strip() or "docker images failed"
        ui.warn(f"Could not list Canyon Docker images: {detail}")
        return

    image_ids = list(dict.fromkeys(result.stdout.split()))
    if not image_ids:
        return

    try:
        with ui.status("Removing Canyon Docker images..."):
            result = subprocess.run(
                ["docker", "image", "rm", *image_ids],
                capture_output=True,
                encoding="utf-8",
                errors="replace",
                check=False,
            )
    except OSError as error:
        ui.warn(f"Could not clean Docker images: {error}")
        return

    if result.returncode != 0:
        detail = result.stderr.strip() or "docker image rm failed"
        ui.warn(f"Could not remove Canyon Docker images: {detail}")
        return

    ui.ok(f"Removed {len(image_ids)} Canyon Docker image(s).")


def _remove_emptied_parents(path):
    parent = os.path.dirname(path)
    while parent and not os.listdir(parent):
        os.rmdir(parent)
        parent = os.path.dirname(parent)


def _remove_canyon_skills():
    """Removes the skill `canyonos convert` installs into this project, leaving global installs."""
    for spec in convert.AGENTS.values():
        skill_dir = spec["skill_dirs"]["local"]
        try:
            if os.path.islink(skill_dir):
                os.unlink(skill_dir)
            elif os.path.isdir(skill_dir):
                shutil.rmtree(skill_dir)
            else:
                continue
            _remove_emptied_parents(skill_dir)
        except OSError as error:
            ui.warn(f"Could not remove {skill_dir}: {error}")
            continue
        ui.ok(f"Removed {skill_dir}.")


def run_clean():
    """Remove the current project's `.canyon` folder (and the project id, when
    `global_controller.yaml` lives there), CanyonOS skill, and the Docker images built
    for its agents."""
    # A built project keeps its agent list inside .canyon, which goes first.
    images = _project_images()
    canyon_dir = os.path.join(os.getcwd(), CANYON_DIR)

    if os.path.isdir(canyon_dir):
        with ui.status(f"Cleaning {canyon_dir}..."):
            shutil.rmtree(canyon_dir)
        ui.ok(f"Removed {CANYON_DIR}.")
    else:
        ui.say(f"No {CANYON_DIR} folder to remove.")

    _remove_canyon_skills()
    _remove_canyon_images(images)
    ui.ok("Clean complete.")
