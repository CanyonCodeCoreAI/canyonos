# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Core's Kubernetes code stays in canyonos_core/kubernetes/, and only three modules
outside it import from it (AGENTS.md)."""

import ast
import os
import unittest

import canyonos_core

PACKAGE_DIR = os.path.dirname(os.path.abspath(canyonos_core.__file__))
KUBERNETES = "canyonos_core.kubernetes"
ALLOWED = {
    os.path.join("controller", "orchestrator.py"): {f"{KUBERNETES}.orchestrator"},
    "cli.py": {KUBERNETES},
    os.path.join("schema", "kubernetes_block.py"): {f"{KUBERNETES}.api"},
}


def _kubernetes_imports(path):
    """The canyonos_core.kubernetes modules a file imports, as written."""
    with open(path, encoding="utf-8") as f:
        tree = ast.parse(f.read(), path)
    found = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module:
            names = [node.module]
        else:
            continue
        found.update(
            n for n in names if n == KUBERNETES or n.startswith(KUBERNETES + ".")
        )
    return found


class KubernetesBoundaryTests(unittest.TestCase):
    def test_only_the_three_seams_import_the_kubernetes_package(self):
        offenders = {}
        for root, dirs, files in os.walk(PACKAGE_DIR):
            dirs[:] = [d for d in dirs if d not in ("kubernetes", "__pycache__")]
            for name in files:
                if not name.endswith(".py"):
                    continue
                path = os.path.join(root, name)
                relative = os.path.relpath(path, PACKAGE_DIR)
                imported = _kubernetes_imports(path) - ALLOWED.get(relative, set())
                if imported:
                    offenders[relative] = sorted(imported)
        self.assertEqual(offenders, {})

    def test_the_package_itself_loads_none_of_its_modules(self):
        init = os.path.join(PACKAGE_DIR, "kubernetes", "__init__.py")
        with open(init, encoding="utf-8") as f:
            tree = ast.parse(f.read(), init)
        self.assertFalse(
            [n for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom))]
        )


if __name__ == "__main__":
    unittest.main()
