# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos validate`: check the project root against the CanyonOS contract.

The checks themselves live in `canyonos_core.validate`, beside the schema, the
platform pins and the Dockerfile templates they are about -- this command only
runs them and renders what comes back. Two ways in, in this order:

- imported here, when `canyonos_core` is installed alongside the CLI (a dev
  checkout, or the CLI running inside the Global Controller image)
- otherwise the same module inside the core image, over a read-only bind mount
  of the root itself

Exit 0 when nothing is found, 1 when something is, and 2 when the check could
not run at all -- so a caller can tell a broken project from one nobody looked at.
"""

import json
import os
import shutil
import subprocess
import textwrap
import uuid

from canyonos import env, ui
from canyonos.constants import existing_config_path, project_root
from canyonos.docker_cmd import DOCKER_PULL_TIMEOUT, cleanup_docker
from canyonos.init import docker_is_local, docker_running

# Distinct from 1 (findings) the way grep and diff use it: trouble, not a result.
UNCHECKED = 2
CORE_MODULE = "canyonos_core.validate"
WORKSPACE = "/workspace"
# Wide enough for a mechanism paragraph, narrow enough to stay readable.
WRAP_WIDTH = 78
# What the renderer reads out of a finding, and the type it reads it as.
FINDING_FIELDS = {
    "code": str,
    "path": str,
    "line": int,
    "summary": str,
    "mechanism": str,
}


def _import_validate_root():
    """Core's validator, or None when core is not installed beside this CLI.

    The released CLI is a single binary with none of core in it, so this is
    expected to miss and fall through to the image.
    """
    try:
        from canyonos_core.validate import validate_root
    except ImportError:
        return None
    return validate_root


def _in_process(root):
    """Findings from the imported validator, or None when it is not there."""
    validate_root = _import_validate_root()
    if validate_root is None:
        return None
    return [dict(finding._asdict()) for finding in validate_root(root)]


def _docker_argv(root, name):
    """The `docker run` that validates `root` inside the core image.

    The root is the mount, so the container sees no more of the host than the
    artifact being checked, and every path in the findings is already relative
    to it. The image's own entrypoint starts the server, so it is replaced. The
    name is what finds the container again if the run has to be abandoned.
    """
    return [
        "docker",
        "run",
        "--rm",
        "--name",
        name,
        "-v",
        f"{os.path.abspath(root)}:{WORKSPACE}:ro",
        "-w",
        WORKSPACE,
        "--entrypoint",
        "python",
        env.core_image,
        "-m",
        CORE_MODULE,
        ".",
        "--json",
    ]


def _is_finding(finding):
    return isinstance(finding, dict) and all(
        isinstance(finding.get(field), kind) for field, kind in FINDING_FIELDS.items()
    )


def _findings_from(stdout):
    """The findings in the container's reply, or None when it is not one."""
    try:
        findings = json.loads(stdout)["findings"]
    except (ValueError, KeyError, TypeError):
        return None
    if not isinstance(findings, list) or not all(map(_is_finding, findings)):
        return None
    return findings


def _in_image(root):
    """Findings from the validator run inside the core image."""
    if not shutil.which("docker"):
        raise RuntimeError(
            "`canyonos validate` needs either canyonos-core installed here or "
            "Docker to run it in the core image; neither is available."
        )
    if not docker_running():
        raise RuntimeError("Docker isn't running. Start it, then rerun.")
    if not docker_is_local():
        raise RuntimeError(
            "Docker is running on another machine (DOCKER_HOST or the active context "
            "is tcp:// or ssh://), so the project cannot be bind-mounted into the "
            "core image."
        )

    name = f"canyonos-validate-{uuid.uuid4().hex[:12]}"
    try:
        # Bounded by the pull timeout: `docker run` pulls a missing image first.
        result = subprocess.run(
            _docker_argv(root, name),
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=DOCKER_PULL_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        # Killing the client leaves the container running; this run started
        # it, so this run removes it.
        failure = cleanup_docker(
            ["docker", "rm", "-f", name],
            action=f"Removing validator container {name}",
            missing_text="No such container",
        )
        raise RuntimeError(
            f"The validator in {env.core_image} did not finish within "
            f"{DOCKER_PULL_TIMEOUT}s." + (f" {failure}" if failure else "")
        ) from None
    findings = _findings_from(result.stdout)
    if findings is None:
        detail = (result.stderr or result.stdout).strip().splitlines()
        raise RuntimeError(
            f"The validator in {env.core_image} returned no findings: "
            f"{detail[-1] if detail else f'exit {result.returncode}'}"
        )
    return findings


# ------------------------------------------------------------------ #
#  Output                                                             #
# ------------------------------------------------------------------ #


def _say_wrapped(text, indent):
    for line in textwrap.wrap(text, width=WRAP_WIDTH - len(indent)):
        ui.say(indent + line)


def _print_findings(findings, root):
    for finding in findings:
        where = finding["path"]
        if where and finding["line"]:
            where = f"{where}:{finding['line']}"
        ui.say(f"{finding['code']}  {where}".rstrip())
        _say_wrapped(finding["summary"], "    ")
        _say_wrapped(finding["mechanism"], "      ")
        ui.blank()

    if findings:
        ui.fail(f"{len(findings)} error(s).")
    else:
        ui.ok(f"{root}: clean.")


def run_validate(root=None, as_json=False):
    """Report every contract the given folder, or the project root, breaks. Returns
    the exit status: 2 when there is no project here to check."""
    ui.set_quiet(as_json)
    checks_project = root is None
    if checks_project:
        root = project_root()
    try:
        try:
            if checks_project:
                existing_config_path()
            if not os.path.isdir(root):
                # Checked before either path: `docker run -v` would create it.
                raise RuntimeError(f"{root} is not a directory.")
            findings = _in_process(root)
            if findings is None:
                findings = _in_image(root)
        except RuntimeError as e:
            # Nothing was checked, so the reason goes where the findings would
            # have, rather than an empty run that reads as a pass.
            if as_json:
                # The same keys as a run that happened, so a reader keying on
                # `errors` gets an explicit null rather than a KeyError.
                print(
                    json.dumps(
                        {
                            "root": os.path.abspath(root),
                            "errors": None,
                            "error": str(e),
                            "findings": [],
                        },
                        indent=2,
                    )
                )
            else:
                ui.fail(str(e))
            return UNCHECKED

        if as_json:
            print(
                json.dumps(
                    {
                        "root": os.path.abspath(root),
                        "errors": len(findings),
                        "findings": findings,
                    },
                    indent=2,
                )
            )
        else:
            _print_findings(findings, root)
        return 1 if findings else 0
    finally:
        ui.set_quiet(False)
