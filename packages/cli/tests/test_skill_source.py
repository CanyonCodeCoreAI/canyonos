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
# The skill links the contract reference in `docs/`: as raw markdown for the
# agent, and on the published site where it points the developer. Either way
# every link has to name a file and heading the repository still has; the
# site's home page is the repository README.
RAW_LINK = re.compile(
    r"https://raw\.githubusercontent\.com/CanyonCodeCoreAI/canyonos/main/"
    r"([^\s)#]+)(?:#([^\s)]*))?"
)
SITE_LINK = re.compile(
    r"https://canyonos\.readthedocs\.io/en/latest/([^\s)#]*)(?:#([^\s)]*))?"
)
SITE_PAGE = re.compile(r"([\w-]+)/")


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


def test_every_contract_link_names_a_page_and_heading_in_docs():
    broken = {}
    for name in _skill_files(".md"):
        with open(os.path.join(SKILL, name), encoding="utf-8") as handle:
            text = handle.read()
        links = RAW_LINK.findall(text)
        for path, anchor in SITE_LINK.findall(text):
            page = SITE_PAGE.fullmatch(path)
            if path and not page:
                broken[f"{name}: {path}"] = "not a site page path"
                continue
            links.append((f"docs/{page.group(1)}.md" if page else "README.md", anchor))
        for path, anchor in links:
            source = env.REPO_ROOT / path
            if not source.is_file():
                broken[f"{name}: {path}"] = "no such file"
                continue
            headings = re.findall(
                r"^#+\s+(.+)$", source.read_text(encoding="utf-8"), re.MULTILINE
            )
            # MkDocs' default slug: markup and punctuation dropped, spaces joined.
            anchors = {
                re.sub(r"[-\s]+", "-", re.sub(r"[^\w\s-]", "", h).strip().lower())
                for h in headings
            }
            if anchor and anchor not in anchors:
                broken[f"{name}: {path}#{anchor}"] = "no such heading"

    assert broken == {}
