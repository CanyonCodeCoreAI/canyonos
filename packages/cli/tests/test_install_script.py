"""install.sh picks its release with a shell function; run that function on fixtures."""

import json
import re
import subprocess
from pathlib import Path

INSTALL_SH = Path(__file__).parents[1] / "install.sh"


def run_selector(name, releases):
    source = INSTALL_SH.read_text()
    functions = re.findall(r"^\w+\(\) \{.*?^\}", source, re.S | re.M)
    assert any(block.startswith(f"{name}()") for block in functions), (
        f"install.sh has no {name} function"
    )
    result = subprocess.run(
        ["sh", "-c", "\n".join([*functions, name])],
        input=json.dumps(releases),
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def test_installer_picks_the_newest_stable_v_release():
    releases = [
        {"tag_name": "v0.1.734", "prerelease": True},
        {"tag_name": "cli-v0.1.735", "prerelease": False},
        {"tag_name": "v0.1.733-rc.1", "prerelease": False},
        {"tag_name": "v0.1.732", "prerelease": False},
        {"tag_name": "cli-v0.1.731", "prerelease": False},
    ]

    assert run_selector("latest_release_tag", releases) == "v0.1.732"


def test_installer_picks_the_highest_version_whatever_the_list_order():
    releases = [
        {"tag_name": "v0.1.733", "prerelease": False},
        {"tag_name": "v0.1.9", "prerelease": False},
        {"tag_name": "v0.1.734", "prerelease": False},
        {"tag_name": "v0.1.735", "prerelease": True},
    ]

    assert run_selector("latest_release_tag", releases) == "v0.1.734"


def test_installer_finds_no_v_release_among_legacy_tags():
    assert (
        run_selector(
            "latest_release_tag", [{"tag_name": "cli-v0.1.731", "prerelease": False}]
        )
        == ""
    )
