"""Every command shares one entrypoint, so a broken import in any module takes down the whole CLI."""

import importlib
import pkgutil

import pytest

import canyonos

MODULES = ["cli"] + [
    f"canyonos.{info.name}" for info in pkgutil.iter_modules(canyonos.__path__)
]


@pytest.mark.parametrize("module", MODULES)
def test_module_imports(module):
    importlib.import_module(module)
