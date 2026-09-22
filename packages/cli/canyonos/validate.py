"""
Logic for `canyonos validate`: check a ported `.car` against the CanyonOS contract.

The checks themselves live in `canyonos_core.validate`, beside the schema, the
platform pins and the Dockerfile templates they are about -- this command only
runs them and renders what comes back. Two ways in, in this order:

- imported here, when `canyonos_core` is installed alongside the CLI (a dev
  checkout, or the CLI running inside the Global Controller image)
- otherwise the same module inside the core image, over a read-only bind mount
  of the `.car` itself

Exit 0 when nothing is found, 1 otherwise.
"""

import json
import os
import shutil
import subprocess
import textwrap

from canyonos import env, ui
from canyonos.init import active_docker_socket

DEFAULT_ARTIFACT_ROOT = ".car"
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


def _relative_config(artifact_root, config):
    """`config` as a path inside the artifact, whichever way it was written.

    The image sees the `.car` and nothing above it, so a manifest outside it
    could not be read there and must not be read here either.
    """
    if config is None:
        return None
    root = os.path.abspath(artifact_root)
    relative = os.path.relpath(os.path.abspath(os.path.join(root, config)), root)
    if relative == os.pardir or relative.startswith(os.pardir + os.sep):
        raise RuntimeError(
            f"--config {config} is outside {artifact_root}; the manifest has to "
            "live in the .car that is being checked."
        )
    return relative


def _import_validate_car():
    """Core's validator, or None when core is not installed beside this CLI.

    The released CLI is a single binary with none of core in it, so this is
    expected to miss and fall through to the image.
    """
    try:
        from canyonos_core.validate import validate_car
    except ImportError:
        return None
    return validate_car


def _in_process(artifact_root, config):
    """Findings from the imported validator, or None when it is not there."""
    validate_car = _import_validate_car()
    if validate_car is None:
        return None
    return [dict(finding._asdict()) for finding in validate_car(artifact_root, config)]


def _docker_argv(artifact_root, config):
    """The `docker run` that validates `artifact_root` inside the core image.

    The `.car` is the mount, so the container sees no more of the host than the
    artifact being checked, and every path in the findings is already relative
    to it.
    """
    argv = [
        "docker",
        "run",
        "--rm",
        "-v",
        f"{os.path.abspath(artifact_root)}:{WORKSPACE}:ro",
        "-w",
        WORKSPACE,
        env.core_image,
        "python",
        "-m",
        CORE_MODULE,
        ".",
    ]
    if config:
        argv += ["--config", config]
    return argv + ["--json"]


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


def _in_image(artifact_root, config):
    """Findings from the validator run inside the core image."""
    if not shutil.which("docker"):
        raise RuntimeError(
            "`canyonos validate` needs either canyonos-core installed here or "
            "Docker to run it in the core image; neither is available."
        )
    if active_docker_socket() is None:
        raise RuntimeError(
            "Docker is not reachable over a local socket (remote context, or the "
            "daemon is not running), so the .car cannot be bind-mounted into the "
            "core image."
        )

    result = subprocess.run(
        _docker_argv(artifact_root, config), capture_output=True, text=True
    )
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


def _print_findings(findings, artifact_root):
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
        ui.ok(f"{artifact_root}: clean.")


def run_validate(artifact_root=DEFAULT_ARTIFACT_ROOT, config=None, as_json=False):
    """Report every contract the `.car` breaks. Returns the exit status."""
    ui.set_quiet(as_json)
    try:
        try:
            config = _relative_config(artifact_root, config)
            findings = _in_process(artifact_root, config)
            if findings is None:
                findings = _in_image(artifact_root, config)
        except RuntimeError as e:
            # Nothing was checked, so the reason goes where the findings would
            # have, rather than an empty run that reads as a pass.
            if as_json:
                # The same keys as a run that happened, so a reader keying on
                # `errors` gets an explicit null rather than a KeyError.
                print(
                    json.dumps(
                        {
                            "artifact_root": os.path.abspath(artifact_root),
                            "errors": None,
                            "error": str(e),
                            "findings": [],
                        },
                        indent=2,
                    )
                )
            else:
                ui.fail(str(e))
            return 1

        if as_json:
            print(
                json.dumps(
                    {
                        "artifact_root": os.path.abspath(artifact_root),
                        "errors": len(findings),
                        "findings": findings,
                    },
                    indent=2,
                )
            )
        else:
            _print_findings(findings, artifact_root)
        return 1 if findings else 0
    finally:
        ui.set_quiet(False)
