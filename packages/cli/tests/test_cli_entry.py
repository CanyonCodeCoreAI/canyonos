import importlib.metadata
import os
import subprocess
import sys

import pytest


def test_the_canyonos_entry_point_imports_in_a_fresh_interpreter():
    """`canyonos` is `cli:main`; if `import cli` fails, every command fails.

    Run in a fresh interpreter: inside the suite another test may already have
    imported the modules involved, which is how a broken import once passed.
    """
    result = subprocess.run(
        [sys.executable, "-c", "import cli; assert callable(cli.main)"],
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize(
    "environment, expected",
    [
        ("", importlib.metadata.version("canyonos")),
        ("development", "development"),
        ("test", "test"),
    ],
)
def test_version_is_the_release_in_production_and_the_environment_otherwise(
    environment, expected
):
    # Set even when empty, so a contributor's packages/cli/.env cannot override
    # them: in production a dev-only override would make the import raise.
    variables = {
        "CANYONOS_ENV": environment,
        "CANYONOS_CORE_IMAGE": "",
        "CANYONOS_SKILL_SOURCE": "",
        "CANYONOS_API_IMAGE": "",
        "CANYONOS_WEB_IMAGE": "",
    }
    result = subprocess.run(
        [sys.executable, "-c", "import cli; cli.main()", "-v"],
        capture_output=True,
        text=True,
        timeout=60,
        env={**os.environ, **variables},
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout == f"canyonos {expected}\n"
