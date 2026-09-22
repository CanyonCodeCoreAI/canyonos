"""What the `porting-to-canyonos` skill is allowed to ship.

`canyonos build` installs the skill directory wholesale, so whatever sits in it
travels to every ported project. The checks the skill used to carry now live in
`canyonos validate`, reading the constants in `canyonos_core` itself; a second
copy of them in the skill would drift from the runtime it describes without
anything failing. These tests keep that copy from coming back.
"""

import os
import re

from canyonos import env

SKILL = env.LOCAL_SKILL_DIR
# The one script the skill still runs itself: it prepares `.car`, and there is
# no `.car` for the CLI to work on until it has.
ALLOWED_SCRIPTS = {"prepare.py"}
# The retired validator's own code scheme. `canyonos validate` names every
# finding CAR-*, so a V0xx or W0xx left in the prose cites a check that no
# longer runs and sends a reader looking for output they will never see.
RETIRED_CODE = re.compile(r"\b[VW]0[0-9]{2}\b")


def _skill_files(suffix):
    for directory, _subdirectories, names in os.walk(SKILL):
        for name in names:
            if name.endswith(suffix):
                yield os.path.relpath(os.path.join(directory, name), SKILL)


def test_the_skill_ships_no_python_but_prepare():
    assert set(_skill_files(".py")) == ALLOWED_SCRIPTS


def test_no_reference_still_cites_a_retired_finding_code():
    cited = {}
    for name in _skill_files(".md"):
        with open(os.path.join(SKILL, name), encoding="utf-8") as handle:
            for number, line in enumerate(handle, start=1):
                if RETIRED_CODE.search(line):
                    cited[f"{name}:{number}"] = line.strip()

    assert cited == {}
