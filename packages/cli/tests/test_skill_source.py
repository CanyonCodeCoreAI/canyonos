"""What the `porting-to-canyonos` skill is allowed to ship.

`canyonos build` installs the skill directory wholesale, so whatever sits in it
travels to every ported project. The checks the skill used to carry now live in
`canyonos validate`, reading the constants in `canyonos_core` itself; a second
copy of them in the skill would drift from the runtime it describes without
anything failing. These tests keep that copy from coming back.
"""

import os

from canyonos import env

SKILL = env.LOCAL_SKILL_DIR
# The one script the skill still runs itself: it prepares `.car`, and there is
# no `.car` for the CLI to work on until it has.
ALLOWED_SCRIPTS = {"prepare.py"}


def _skill_files(suffix):
    for directory, _subdirectories, names in os.walk(SKILL):
        for name in names:
            if name.endswith(suffix):
                yield os.path.relpath(os.path.join(directory, name), SKILL)


def test_the_skill_ships_no_python_but_prepare():
    assert set(_skill_files(".py")) == ALLOWED_SCRIPTS
