# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos new-app`: scaffold a starter workflow in the current
directory. Runs locally, no container involved.
"""

# nosemgrep: python.lang.compatibility.python37.python37-compatibility-importlib2
import importlib.resources
import os

from canyonos import ui
from canyonos.constants import DEPLOYMENT_CONFIG

TEMPLATE_DIR = "new_app_template"

# Nuitka compiles every `.py` it ships, so the starter's Python files carry this
# suffix inside the package and lose it when written out.
PYTHON_TEMPLATE_SUFFIX = ".tmpl"


def template_files():
    """Yield (relative target path, content) for every file of the starter workflow."""
    root = importlib.resources.files("canyonos").joinpath(TEMPLATE_DIR)
    for directory, _, filenames in os.walk(str(root)):
        for filename in filenames:
            source = os.path.join(directory, filename)
            relative = os.path.relpath(source, str(root))
            # newline="": each file's own line endings, the same on every OS.
            with open(source, encoding="utf-8", newline="") as f:
                yield relative.removesuffix(PYTHON_TEMPLATE_SUFFIX), f.read()


def deployment_template():
    """Return the `workflow_group.yaml` `canyonos deploy` writes when a workflow group has none."""
    return (
        importlib.resources.files("canyonos")
        .joinpath(DEPLOYMENT_CONFIG)
        .read_text(encoding="utf-8")
    )


def run_new_app():
    """Run `canyonos new-app`: write a one-agent starter workflow into the current
    directory, which must be empty. Returns False when nothing was written."""
    if os.listdir("."):
        ui.fail("Directory is not empty. Run `canyonos new-app` in an empty directory.")
        return False

    for path, content in template_files():
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(content)

    name = os.path.basename(os.getcwd())
    ui.ok("Created new CanyonOS workflow.")
    ui.hint(
        f"Deploy it with `cd .. && canyonos deploy {name} --workflow-group {name}-group`."
    )
    return True
