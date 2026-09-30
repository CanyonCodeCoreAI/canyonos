from pathlib import Path

import canyonos_core
import tomllib


def test_version_matches_pyproject():
    pyproject = Path(__file__).parents[1] / "pyproject.toml"
    expected = tomllib.loads(pyproject.read_text())["project"]["version"]
    assert canyonos_core.__version__ == expected
