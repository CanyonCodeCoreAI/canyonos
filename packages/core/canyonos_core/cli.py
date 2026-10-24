# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
CanyonOS CLI

Entry point for the `canyonos` command. Provides these subcommands:
    canyonos deploy               — Build (stubs + Docker images) then launch
                                  agents via the Global Controller
"""

import argparse
import glob
import json
import logging
import os
import subprocess
import sys

from canyonos_core.controller.utils.config_env import load_config
from canyonos_core.controller.utils.docker_utils import docker_available
from canyonos_core.controller.utils.container_names import image_name
from canyonos_core.controller.utils.env_file import resolve_env_file
from canyonos_core.reconciler import providers
from canyonos_core.schema import (
    check_project,
    render_violation,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("canyonos_core")
ARTIFACT_DIR_NAME = ".car"
SOURCE_DIR_NAME = "app"


# ------------------------------------------------------------------ #
#  Helpers                                                             #
# ------------------------------------------------------------------ #


def _get_package_dir():
    """Return the absolute path to the canyonos package directory."""
    return os.path.dirname(os.path.abspath(__file__))


def _artifact_prefix(root):
    return (
        ARTIFACT_DIR_NAME
        if os.path.isdir(os.path.join(root, ARTIFACT_DIR_NAME))
        else ""
    )


def _project_layout():
    """(artifact_root, source_root) for the project in cwd.

    The .car layout keeps the app's own code under `.car/app` and everything
    generated beside it; a plain checkout keeps both at the project root.
    """
    project_dir = os.path.abspath(os.getcwd())
    prefix = _artifact_prefix(project_dir)
    artifact_root = os.path.join(project_dir, prefix) if prefix else project_dir
    return (
        artifact_root,
        os.path.join(artifact_root, SOURCE_DIR_NAME) if prefix else project_dir,
    )


def _reject(violations, summary):
    """Log each violation on its own line, then exit.

    The host CLI reads the first `ERROR:` line out of this process's output as
    the root cause, so a violation is never split across lines.
    """
    for violation in violations:
        logger.error("%s", render_violation(violation))
    logger.error(summary, len(violations))
    sys.exit(1)


def _validate_or_exit(config_path, source_dir=None):
    """Reject the config before anything is generated; return the parsed manifest."""
    manifest, violations = check_project(config_path, source_dir)
    if violations:
        _reject(
            violations,
            "Configuration rejected: %d problem(s) found; nothing was built.",
        )
    return manifest


def _normalize_requirements(agent_spec):
    """Return an agent's `requirements` list; the schema already checked its shape."""
    return list(agent_spec.get("requirements") or [])


def _write_bake_file(bake_targets, bake_file_path, platform):
    """Write a docker-buildx-bake JSON file describing all build targets.

    Context paths are written absolute: `docker buildx bake` resolves relative
    `context` values against the invocation cwd (not the bake file's own
    directory), so an absolute path sidesteps that ambiguity entirely.
    """
    bake_config = {
        "target": {
            target["name"]: {
                "context": os.path.abspath(target["context"]),
                "dockerfile": "Dockerfile",
                "tags": [target["image_name"]],
                "platforms": [platform],
                "output": ["type=docker"],
                # type=docker could be changed to tarring it up, which would be
                # faster but skipped because that change would alter canyonos deploy
            }
            for target in bake_targets
        }
    }
    with open(bake_file_path, "w") as f:
        json.dump(bake_config, f, indent=2)
    return bake_file_path


def _ensure_grpc_stubs_importable(project_dir):
    grpc_stubs_dir = os.path.join(project_dir, "grpc_stubs")
    if grpc_stubs_dir not in sys.path:
        sys.path.insert(0, grpc_stubs_dir)

    try:
        __import__("local_controller_pb2")
        __import__("local_controller_pb2_grpc")
    except ImportError as exc:
        raise RuntimeError(
            "Deploy failed: generated grpc_stubs are missing or not importable. "
            "Run `canyonos deploy` again."
        ) from exc


# ------------------------------------------------------------------ #
#  canyonos build                                                        #
# ------------------------------------------------------------------ #


def _run_build(config_path):
    """
    Generate stubs, compile gRPC protos, generate Docker contexts,
    and build Docker images.

    Must be run from the project root (where config/ lives). Invoked as the
    first phase of `canyonos deploy`.
    """
    if not os.path.isfile(config_path):
        logger.error("Config file not found: %s", config_path)
        sys.exit(1)

    artifact_root, source_root = _project_layout()

    # Nothing below runs against a config the schema rejects. Validate before loading so
    # non-YAML files render as violations too, and pass source_root so an agent with
    # missing code fails here instead of being skipped from a "successful" deploy.
    manifest = _validate_or_exit(config_path, source_root)

    config = load_config(config_path)
    agent_specs = config.get("agents", [])
    package_dir = _get_package_dir()

    from canyonos_core.stub_generator import (
        too_new_requirements,
        too_old_requirements,
    )

    too_old = []
    for agent_spec in agent_specs:
        requirements = _normalize_requirements(agent_spec)
        too_old += [
            f"{agent_spec['name']} currently requires {asked}, but CanyonOS only supports {supported}"
            for asked, supported in too_old_requirements(requirements)
        ]
        for asked, tested in too_new_requirements(requirements):
            logger.warning(
                "%s currently requires %s, but CanyonOS has only tested %s; it may not work",
                agent_spec["name"],
                asked,
                tested,
            )
    for message in too_old:
        logger.error("%s", message)
    if too_old:
        sys.exit(1)

    # -------------------------------------------------------------- #
    #  Step 1: Generate Python stubs from the agents' functions       #
    # -------------------------------------------------------------- #
    stubs_dir = os.path.join(artifact_root, "stubs")
    os.makedirs(stubs_dir, exist_ok=True)

    from canyonos_core.stub_generator import (
        generate_stub,
        generate_docker,
        target_docker_platform,
    )

    code_agent_specs = [
        agent_spec for agent_spec in manifest.agents if agent_spec.type == "agent"
    ]

    # Keyed by the stub's own basename, which is the entrypoint's: the stub is
    # written to `stubs/<entrypoint>` below.
    stub_entrypoints = {
        os.path.basename(code_agent_spec.entrypoint): code_agent_spec.entrypoint
        for code_agent_spec in code_agent_specs
    }

    stub_paths = []
    for code_agent_spec in code_agent_specs:
        output_path = os.path.join(stubs_dir, code_agent_spec.entrypoint)
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        logger.info("Generating stub: %s -> %s", code_agent_spec.name, output_path)
        generate_stub(code_agent_spec, output_path)
        stub_paths.append(output_path)

    # -------------------------------------------------------------- #
    #  Step 2: Compile gRPC protobuf stubs                            #
    # -------------------------------------------------------------- #
    grpc_stubs_dir = os.path.join(artifact_root, "grpc_stubs")
    os.makedirs(grpc_stubs_dir, exist_ok=True)

    proto_dir = os.path.join(package_dir, "controller", "proto")
    proto_files = glob.glob(os.path.join(proto_dir, "*.proto"))

    for proto_file in proto_files:
        logger.info("Compiling gRPC proto: %s", proto_file)
        subprocess.run(
            [
                sys.executable,
                "-m",
                "grpc_tools.protoc",
                f"-I{proto_dir}",
                f"--python_out={grpc_stubs_dir}",
                f"--grpc_python_out={grpc_stubs_dir}",
                proto_file,
            ],
            check=True,
        )

    # -------------------------------------------------------------- #
    #  Step 4: Generate Docker contexts                               #
    # -------------------------------------------------------------- #
    platform = target_docker_platform(agent_specs)
    bake_targets = []
    for agent_spec in agent_specs:
        agent_name = agent_spec["name"]
        agent_type = agent_spec.get("type", "agent")

        if agent_type == "database":
            # No build: pull the declared image and tag it like any other
            # agent image so the rest of the deploy pipeline treats it the
            # same way (EC2 image transfer, etc.) without further changes.
            image = agent_spec["image"]
            target_image = image_name(agent_name)
            logger.info("Pulling database image '%s' as '%s'", image, target_image)
            subprocess.run(
                ["docker", "pull", "--platform", platform, image], check=True
            )
            subprocess.run(["docker", "tag", image, target_image], check=True)
            continue

        # Every key read below is one the schema requires and has checked,
        # down to the file being on disk -- an agent that cannot be built
        # fails the deploy rather than dropping quietly out of it.
        agent_file = os.path.join(source_root, agent_spec["entrypoint"])
        docker_context = os.path.join(artifact_root, "docker_container", agent_name)
        logger.info("Generating Docker context for '%s'", agent_name)
        generate_docker(
            agent_name,
            agent_file,
            output_dir=docker_context,
            grpc_stubs_dir=grpc_stubs_dir,
            stub_files=stub_paths,
            project_dir=source_root,
            requirements=_normalize_requirements(agent_spec),
            stub_entrypoints=stub_entrypoints,
        )

        bake_targets.append(
            {
                "name": agent_name.lower(),
                "context": docker_context,
                "image_name": image_name(agent_name),
            }
        )

    # -------------------------------------------------------------- #
    #  Step 5: Build all Docker images                                #
    # -------------------------------------------------------------- #
    if not bake_targets:
        logger.info("No Docker images to build.")
    elif docker_available() and docker_available(("docker", "buildx", "version")):
        docker_container_dir = os.path.join(artifact_root, "docker_container")
        os.makedirs(docker_container_dir, exist_ok=True)
        bake_file_path = os.path.join(docker_container_dir, "docker-bake.json")
        _write_bake_file(bake_targets, bake_file_path, platform)

        target_names = [target["name"] for target in bake_targets]
        logger.info(
            "Building %d Docker image(s) via `docker buildx bake`.",
            len(bake_targets),
        )
        subprocess.run(
            ["docker", "buildx", "bake", "--file", bake_file_path, *target_names],
            check=True,
        )
    else:
        logger.info(
            "docker buildx unavailable; falling back to sequential `docker build`."
        )
        for target in bake_targets:
            logger.info("Building Docker image: %s", target["image_name"])
            subprocess.run(
                [
                    "docker",
                    "build",
                    "--platform",
                    platform,
                    "-t",
                    target["image_name"],
                    target["context"],
                ],
                check=True,
            )

    logger.info("Build complete.")


# ------------------------------------------------------------------ #
#  canyonos deploy                                                       #
# ------------------------------------------------------------------ #


def _cmd_deploy(args):
    """
    Launch the Global Controller, which starts Redis containers,
    agent containers, and enters the health-monitoring loop.
    """
    import signal
    import atexit

    config_path = args.config
    if not os.path.isfile(config_path):
        logger.error("Config file not found: %s", config_path)
        sys.exit(1)

    # Build first (stubs, protos, Docker contexts, images), then deploy them.
    # `canyonos build` was merged into `canyonos deploy`.
    _run_build(config_path)

    config = load_config(config_path)
    project_dir = os.path.abspath(os.getcwd())
    prefix = _artifact_prefix(project_dir)
    artifact_root = os.path.join(project_dir, prefix) if prefix else project_dir

    # Fail here rather than after a fleet of containers is already up without
    # the API keys they need. base_dir matches GlobalController, which resolves
    # env_file against its cwd -- any other base rejects a file it would find.
    try:
        resolve_env_file(config, base_dir=project_dir)
    except ValueError as e:
        logger.error("%s", e)
        sys.exit(1)

    _ensure_grpc_stubs_importable(artifact_root)

    for name in dict.fromkeys(
        agent_spec.get("provider", providers.DEFAULT)
        for agent_spec in config.get("agents", [])
    ):
        providers.get(name).preflight()

    from canyonos_core.controller.global_controller import GlobalController

    try:
        controller = GlobalController(config_path)
    except RuntimeError as e:
        # One CRITICAL line, not a traceback, for `canyonos deploy` to report.
        logger.critical("%s", e)
        sys.exit(1)

    # Graceful shutdown on Ctrl+C / SIGTERM
    def _signal_handler(sig, frame):
        logger.info("Received signal %s, shutting down...", signal.Signals(sig).name)
        controller.cleanup()
        sys.exit(0)

    signal.signal(signal.SIGINT, _signal_handler)
    signal.signal(signal.SIGTERM, _signal_handler)
    atexit.register(controller.cleanup)

    # SIGHUP reloads config in place without tearing down any agent.
    def _reload_handler(sig, frame):
        logger.info("Received SIGHUP, reloading config...")
        try:
            controller.reload_config()
        except Exception as e:
            logger.error("Reload failed: %s", e)

    signal.signal(signal.SIGHUP, _reload_handler)

    logger.info("Deploying from config: %s", config_path)
    try:
        controller._wait_for_healthy()
    except RuntimeError as e:
        # One CRITICAL line, not a traceback: `canyonos deploy` reports the line
        # that tripped the failure as the root cause, and the cause itself sits in
        # the container logs dumped just above it.
        logger.critical("Controller readiness failed: %s", e)
        sys.exit(1)
    controller.run()


# ------------------------------------------------------------------ #
#  canyonos clean                                                        #
# ------------------------------------------------------------------ #


def _cmd_clean(args):
    """
    Remove generated stubs, gRPC files, and Docker build contexts.
    """
    project_dir = os.path.abspath(os.getcwd())
    prefix = _artifact_prefix(project_dir)
    artifact_root = os.path.join(project_dir, prefix) if prefix else project_dir

    paths_to_clean = [
        os.path.join(artifact_root, "stubs"),
        os.path.join(artifact_root, "grpc_stubs"),
        os.path.join(artifact_root, "docker_container"),
    ]

    for path in paths_to_clean:
        if os.path.exists(path):
            logger.info("Cleaning %s...", path)
            if os.path.isdir(path):
                import shutil

                shutil.rmtree(path)
            else:
                os.remove(path)

    logger.info("Clean complete.")


# ------------------------------------------------------------------ #
#  Main entry point                                                    #
# ------------------------------------------------------------------ #


def main():
    """Run the core command given on the command line. The container's server uses it to
    build and deploy the project when the CLI asks."""
    default_config_path = os.path.join(
        _artifact_prefix(os.getcwd()), "config", "global_controller.yaml"
    )
    parser = argparse.ArgumentParser(
        prog="canyonos_core",
        description="CanyonOS — Distributed Agent Orchestration Framework",
    )
    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # canyonos deploy
    deploy = subparsers.add_parser(
        "deploy",
        help="Build stubs/images, then launch agents via the Global Controller",
    )
    deploy.add_argument(
        "-c",
        "--config",
        default=default_config_path,
        help=f"Path to global controller config (default: {default_config_path})",
    )
    deploy.set_defaults(func=_cmd_deploy)

    # canyonos clean
    clean = subparsers.add_parser(
        "clean",
        help="Remove generated stubs, compiled protos, and Docker contexts",
    )
    clean.set_defaults(func=_cmd_clean)

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(1)

    args.func(args)


if __name__ == "__main__":
    main()
