import subprocess
import sys


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
