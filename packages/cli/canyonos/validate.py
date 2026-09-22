"""
Logic for `canyonos validate`: check a ported `.car` against the CanyonOS contract.

The checks themselves live in `canyonos_core.validate`, beside the schema, the
platform pins and the Dockerfile templates they are about -- this command only
runs them and renders what comes back. Two ways in, in this order:

- imported here, when `canyonos_core` is installed alongside the CLI (a dev
  checkout, or the CLI running inside the Global Controller image)
- otherwise the same module inside the core image, over a read-only bind mount
  of the project directory

Exit 0 clean, 1 on errors, 1 on warnings alone with `--strict`.
"""

import json
import os
import shutil
import subprocess

from canyonos import env, ui
from canyonos.init import _active_docker_socket

DEFAULT_ARTIFACT_ROOT = ".car"
CORE_MODULE = "canyonos_core.validate"
WORKSPACE = "/workspace"
# Wide enough for a mechanism paragraph, narrow enough to stay readable.
WRAP_WIDTH = 78


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

    The project directory is mounted read-only and the artifact is named
    relative to it, so the findings come back with the paths the user sees.
    """
    root = os.path.abspath(artifact_root)
    argv = [
        "docker",
        "run",
        "--rm",
        "-v",
        f"{os.path.dirname(root)}:{WORKSPACE}:ro",
        "-w",
        WORKSPACE,
        env.core_image,
        "python",
        "-m",
        CORE_MODULE,
        os.path.basename(root),
    ]
    if config:
        argv += ["--config", config]
    return argv + ["--json"]


def _in_image(artifact_root, config):
    """Findings from the validator run inside the core image."""
    if not shutil.which("docker"):
        raise RuntimeError(
            "`canyonos validate` needs either canyonos-core installed here or "
            "Docker to run it in the core image; neither is available."
        )
    if _active_docker_socket() is None:
        raise RuntimeError(
            "This Docker context is remote, so the project cannot be bind-mounted "
            "into the core image. Run `canyonos validate` against a local Docker "
            "context for now."
        )

    result = subprocess.run(
        _docker_argv(artifact_root, config), capture_output=True, text=True
    )
    try:
        return json.loads(result.stdout)["findings"]
    except (ValueError, KeyError, TypeError):
        detail = (result.stderr or result.stdout).strip().splitlines()
        raise RuntimeError(
            f"The validator in {env.core_image} returned no findings: "
            f"{detail[-1] if detail else f'exit {result.returncode}'}"
        ) from None


# ------------------------------------------------------------------ #
#  Output                                                             #
# ------------------------------------------------------------------ #


def _wrap(text, indent):
    lines = []
    current = ""
    for word in text.split():
        candidate = f"{current} {word}".strip()
        if len(candidate) + len(indent) > WRAP_WIDTH and current:
            lines.append(indent + current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(indent + current)
    return lines


def _print_findings(findings, artifact_root):
    for finding in findings:
        where = finding["path"]
        if where and finding["line"]:
            where = f"{where}:{finding['line']}"
        header = f"{finding['code']}  {finding['level']:<7}"
        ui.say(f"{header}  {where}" if where else header)
        for line in _wrap(finding["summary"], "    "):
            ui.say(line)
        for line in _wrap(finding["mechanism"], "      "):
            ui.say(line)
        ui.blank()

    errors, warnings = _counts(findings)
    if not findings:
        ui.ok(f"{artifact_root}: clean.")
    elif errors:
        ui.fail(f"{errors} error(s), {warnings} warning(s).")
    else:
        ui.warn(f"{errors} error(s), {warnings} warning(s).")


def _counts(findings):
    errors = sum(1 for finding in findings if finding["level"] == "error")
    return errors, len(findings) - errors


def run_validate(
    artifact_root=DEFAULT_ARTIFACT_ROOT, config=None, as_json=False, strict=False
):
    """Report every contract the `.car` breaks. Returns the exit status."""
    ui.set_quiet(as_json)
    try:
        try:
            findings = _in_process(artifact_root, config)
            if findings is None:
                findings = _in_image(artifact_root, config)
        except RuntimeError as e:
            # Nothing was checked, so `--json` gets the reason rather than an
            # empty run that reads as a pass.
            ui.set_quiet(False)
            ui.fail(e)
            return 1

        errors, warnings = _counts(findings)
        if as_json:
            print(
                json.dumps(
                    {
                        "artifact_root": os.path.abspath(artifact_root),
                        "errors": errors,
                        "warnings": warnings,
                        "findings": findings,
                    },
                    indent=2,
                )
            )
        else:
            _print_findings(findings, artifact_root)
        return 1 if errors or (strict and warnings) else 0
    finally:
        ui.set_quiet(False)
