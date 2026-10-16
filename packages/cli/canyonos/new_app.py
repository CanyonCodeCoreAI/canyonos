# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos new-app`: scaffold a starter project in the current
directory. Runs locally, no container involved.
"""

import importlib.resources
import os

from canyonos import ui

TEMPLATE_DIR = "new_app_template"

# Nuitka compiles every `.py` it ships, so the starter's Python files carry this
# suffix inside the package and lose it when written out.
PYTHON_TEMPLATE_SUFFIX = ".tmpl"


def template_files():
    """Yield (relative target path, content) for every file of the starter project."""
    root = importlib.resources.files("canyonos").joinpath(TEMPLATE_DIR)
    for directory, _, filenames in os.walk(str(root)):
        for filename in filenames:
            source = os.path.join(directory, filename)
            relative = os.path.relpath(source, str(root))
            yield relative.removesuffix(PYTHON_TEMPLATE_SUFFIX), open(source).read()


def run_new_app():
    """Run `canyonos new-app`: write a one-agent starter project into the current
    directory, which must be empty. Returns False when nothing was written."""
    if os.listdir("."):
        ui.fail("Directory is not empty. Run `canyonos new-app` in an empty directory.")
        return False

    for path, content in template_files():
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w") as f:
            f.write(content)

    ui.ok("Created new CanyonOS project.")
    ui.hint("Run `canyonos deploy` to start it.")
    return True
