"""Logic for canyonos clean: remove generated artifacts, skills, managed .env keys and images."""

import os
import shutil
import subprocess
from pathlib import Path

from canyonos import build, dashboard_stack, ui

# Core tags every image it builds "canyonos-<agent>"; the ghcr.io dashboard
# images must not match.
IMAGE_REFERENCE = "canyonos-*"


def _remove_canyon_images():
    """Removes all the images prefixed with IMAGE_REFERENCE from machine."""
    try:
        result = subprocess.run(
            ["docker", "images", "--filter", f"reference={IMAGE_REFERENCE}", "-q"],
            capture_output=True,
            text=True,
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
                text=True,
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
    """Removes the skill `canyonos build` installs into this project, leaving global installs."""
    for spec in build.AGENTS.values():
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


def _remove_canyon_env_vars():
    """Strips the keys `canyonos serve` writes from the project's `.env`."""
    try:
        removed = dashboard_stack.remove_project_env_keys(Path.cwd() / ".env")
    except (OSError, UnicodeDecodeError) as error:
        ui.warn(f"Could not clean .env: {error}")
        return
    if removed:
        ui.ok(f"Removed {removed} CanyonOS-managed variable(s) from .env.")


def run_clean():
    """Remove the current project's `.car` folder, CanyonOS skill and the `.env`
    keys `canyonos serve` wrote, and all `canyonos-*` Docker images."""
    car_dir = os.path.join(os.getcwd(), ".car")

    if os.path.isdir(car_dir):
        with ui.status(f"Cleaning {car_dir}..."):
            shutil.rmtree(car_dir)
        ui.ok("Removed .car.")
    else:
        ui.say("No .car folder to remove.")

    _remove_canyon_skills()
    _remove_canyon_env_vars()
    _remove_canyon_images()
    ui.ok("Clean complete.")
