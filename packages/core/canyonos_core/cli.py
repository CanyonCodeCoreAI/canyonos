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
import threading
from functools import partial

from canyonos_core.controller.utils.config_env import load_config, resolve_env_file
from canyonos_core.controller.utils.docker_utils import docker_available
from canyonos_core.controller.utils.container_names import image_name
from canyonos_core.reconciler import providers
from canyonos_core.schema import (
    CONFIG_PATH,
    check_project,
    render_violation,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("canyonos_core")

BUILD_FAILED = "Could not build the agent images; the build output above says why."


# ------------------------------------------------------------------ #
#  Helpers                                                             #
# ------------------------------------------------------------------ #


def _get_package_dir():
    """Return the absolute path to the canyonos package directory."""
    return os.path.dirname(os.path.abspath(__file__))


def _reject(violations, summary):
    """Log each violation on its own line, then exit.

    The host CLI reads the first `ERROR:` line out of this process's output as
    the root cause, so a violation is never split across lines.
    """
    for violation in violations:
        logger.error("%s", render_violation(violation))
    logger.error(summary, len(violations))
    sys.exit(1)


def _validate_or_exit(config_path, root=None):
    """Reject the config before anything is generated; return the parsed manifest."""
    manifest, violations = check_project(config_path, root)
    if violations:
        _reject(
            violations,
            "Configuration rejected: %d problem(s) found; nothing was built.",
        )
    return manifest


def _normalize_requirements(agent_spec):
    """Return an agent's `requirements` list; the schema already checked its shape."""
    return list(agent_spec.get("requirements") or [])


def _write_bake_file(bake_targets, bake_file_path, platform, push_to=None):
    """Write a docker-buildx-bake JSON file describing all build targets.

    Context paths are written absolute: `docker buildx bake` resolves relative
    `context` values against the invocation cwd (not the bake file's own
    directory), so an absolute path sidesteps that ambiguity entirely.

    `push_to` is (registry, tag) for a remote builder: each image is pushed straight
    to the registry from there, as there is no Docker daemon here to load it into.
    """

    def tags(target):
        if push_to is None:
            return [target["image_name"]]
        registry, tag = push_to
        return [f"{registry.rstrip('/')}/{target['image_name']}:{tag}"]

    bake_config = {
        "target": {
            target["name"]: {
                "context": os.path.abspath(target["context"]),
                "dockerfile": "Dockerfile",
                "tags": tags(target),
                "platforms": [platform],
                "output": ["type=docker" if push_to is None else "type=registry"],
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
#  Image build (run by canyonos deploy)                              #
# ------------------------------------------------------------------ #


def _checked_config(config_path):
    """The parsed manifest and the loaded config, once the schema accepts the config and
    every agent's requirements are ones CanyonOS supports; exits otherwise.

    Must be run from the project root (where config/ lives).
    """
    if not os.path.isfile(config_path):
        logger.error("Config file not found: %s", config_path)
        sys.exit(1)

    project_dir = os.getcwd()

    # Nothing below runs against a config the schema rejects. Validate before loading so
    # non-YAML files render as violations too, and pass project_dir so an agent with
    # missing code fails here instead of being skipped from a "successful" deploy.
    manifest = _validate_or_exit(config_path, project_dir)

    config = load_config(config_path)

    from canyonos_core.stub_generator import (
        too_new_requirements,
        too_old_requirements,
    )

    too_old = []
    for agent_spec in config.get("agents", []):
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
    return manifest, config


def _generate_build_contexts(manifest, config):
    """Generate stubs, compile gRPC protos and generate a Docker context for every agent
    with code; return their bake targets. Database agents get none: they run a
    published image as it is."""
    project_dir = os.getcwd()
    package_dir = _get_package_dir()

    # -------------------------------------------------------------- #
    #  Step 1: Generate Python stubs from the agents' functions       #
    # -------------------------------------------------------------- #
    stubs_dir = os.path.join(project_dir, "stubs")
    os.makedirs(stubs_dir, exist_ok=True)

    from canyonos_core.stub_generator import generate_stub, generate_docker

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
    grpc_stubs_dir = os.path.join(project_dir, "grpc_stubs")
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
    #  Step 3: Generate Docker contexts                               #
    # -------------------------------------------------------------- #
    bake_targets = []
    for agent_spec in config.get("agents", []):
        if agent_spec.get("type", "agent") == "database":
            continue
        agent_name = agent_spec["name"]
        # Every key read below is one the schema requires and has checked,
        # down to the file being on disk -- an agent that cannot be built
        # fails the deploy rather than dropping quietly out of it.
        agent_file = os.path.join(project_dir, agent_spec["entrypoint"])
        docker_context = os.path.join(project_dir, "docker_container", agent_name)
        logger.info("Generating Docker context for '%s'", agent_name)
        generate_docker(
            agent_name,
            agent_file,
            output_dir=docker_context,
            grpc_stubs_dir=grpc_stubs_dir,
            stub_files=stub_paths,
            project_dir=project_dir,
            requirements=_normalize_requirements(agent_spec),
            stub_entrypoints=stub_entrypoints,
        )

        bake_targets.append(
            {
                "name": agent_name.lower(),
                "service": agent_name,
                "context": docker_context,
                "image_name": image_name(agent_name),
            }
        )
    return bake_targets


def _run_build(config_path):
    """
    Generate stubs, compile gRPC protos and generate Docker contexts, and start
    pulling database images. Returns a function that, given a list to add its build
    processes to, builds the agent images and waits for those pulls, so
    `canyonos deploy` can start the Global Controller while the images build.

    Must be run from the project root (where config/ lives). Invoked as the
    first phase of `canyonos deploy`.
    """
    manifest, config = _checked_config(config_path)

    from canyonos_core.stub_generator import target_docker_platform

    platform = target_docker_platform(config.get("provider", providers.DEFAULT))
    # Pulled while the agent images build, by processes so a stop never waits on one.
    database_pulls = []
    for agent_spec in config.get("agents", []):
        if agent_spec.get("type", "agent") != "database":
            continue
        # No build: pull the declared image and tag it like any other
        # agent image so the rest of the deploy pipeline treats it the
        # same way (EC2 image transfer, etc.) without further changes.
        agent_name = agent_spec["name"]
        image = agent_spec["image"]
        target_image = image_name(agent_name)
        logger.info("Pulling database image '%s' as '%s'", image, target_image)
        pull = subprocess.Popen(
            ["docker", "pull", "--platform", platform, image],
            stderr=subprocess.PIPE,
            text=True,
        )
        database_pulls.append((pull, image, target_image, agent_name))

    bake_targets = _generate_build_contexts(manifest, config)
    return partial(
        _build_images,
        config_path,
        os.getcwd(),
        bake_targets,
        platform,
        database_pulls,
    )


def _build_images(
    config_path, project_dir, bake_targets, platform, database_pulls, processes
):
    """Build every agent image `_run_build` generated a Docker context for, adding each
    build process to `processes`, then wait for its database image pulls and tag them;
    raises if any of them fails."""

    def run_build(cmd):
        build = subprocess.Popen(cmd)
        processes.append(build)
        if build.wait():
            raise subprocess.CalledProcessError(build.returncode, cmd)

    if not bake_targets:
        logger.info("No Docker images to build.")
    elif docker_available() and docker_available(("docker", "buildx", "version")):
        docker_container_dir = os.path.join(project_dir, "docker_container")
        os.makedirs(docker_container_dir, exist_ok=True)
        bake_file_path = os.path.join(docker_container_dir, "docker-bake.json")
        _write_bake_file(bake_targets, bake_file_path, platform)

        target_names = [target["name"] for target in bake_targets]
        logger.info(
            "Building %d Docker image(s) via `docker buildx bake`.",
            len(bake_targets),
        )
        run_build(["docker", "buildx", "bake", "--file", bake_file_path, *target_names])
    else:
        logger.info(
            "Building %d Docker image(s) via sequential `docker build`: docker buildx "
            "is unavailable.",
            len(bake_targets),
        )
        for target in bake_targets:
            logger.info("Building Docker image: %s", target["image_name"])
            run_build(
                [
                    "docker",
                    "build",
                    "--platform",
                    platform,
                    "-t",
                    target["image_name"],
                    target["context"],
                ]
            )

    for pull, image, target_image, agent_name in database_pulls:
        _, stderr = pull.communicate()
        if pull.returncode:
            raise RuntimeError(
                f"Could not pull image {image} for database agent {agent_name}: "
                f"{stderr.strip()}. Check `image:` in {config_path}."
            )
        subprocess.run(["docker", "tag", image, target_image], check=True)
    logger.info("Build complete.")
    return bake_targets


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

    # Ignores reloads while the deploy starts; a reload then would break the deploy.
    def _ignore_reload(sig, frame):
        logger.warning("Reload ignored: the deploy is still starting.")

    signal.signal(signal.SIGHUP, _ignore_reload)

    config_path = CONFIG_PATH
    if not os.path.isfile(config_path):
        logger.error("Config file not found: %s", config_path)
        sys.exit(1)

    # Stubs, protos and Docker contexts first; the images build while the controller starts.
    try:
        build_images = _run_build(config_path)
    except RuntimeError as e:
        logger.critical("%s", e)
        sys.exit(1)
    except subprocess.CalledProcessError:
        logger.critical(BUILD_FAILED)
        sys.exit(1)

    config = load_config(config_path)
    project_dir = os.getcwd()

    # Fail here rather than after a fleet of containers is already up without
    # the API keys they need.
    try:
        resolve_env_file(config_path)
    except ValueError as e:
        logger.error("%s", e)
        sys.exit(1)

    _ensure_grpc_stubs_importable(project_dir)

    providers.get(config.get("provider", providers.DEFAULT)).preflight()

    build_failures = []
    build_processes = []

    def _build():
        try:
            build_images(build_processes)
        except subprocess.CalledProcessError:
            build_failures.append(BUILD_FAILED)
        except Exception as e:
            build_failures.append(str(e))

    # Stopped at exit, so an abandoned build never tags images over the next deploy's.
    def _stop_builds():
        for build in build_processes:
            build.terminate()

    atexit.register(_stop_builds)

    # Daemon, so a stop during the build exits without waiting for it to finish.
    builder = threading.Thread(target=_build, daemon=True)
    builder.start()

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

    # Joined first, so readiness's timeout does not run during a long build.
    builder.join()
    if build_failures:
        logger.critical("%s", build_failures[0])
        sys.exit(1)
    controller.orchestrator.mark_images_ready()

    logger.info("Deploying from config: %s", config_path)
    try:
        controller._wait_for_healthy()
    except RuntimeError as e:
        # One CRITICAL line, not a traceback: `canyonos deploy` reports the line
        # that tripped the failure as the root cause, and the cause itself sits in
        # the container logs dumped just above it.
        logger.critical("%s", e)
        sys.exit(1)
    controller.run()


# ------------------------------------------------------------------ #
#  canyonos clean                                                        #
# ------------------------------------------------------------------ #


def _cmd_clean(args):
    """
    Remove generated stubs, gRPC files, and Docker build contexts.
    """
    project_dir = os.getcwd()

    paths_to_clean = [
        os.path.join(project_dir, "stubs"),
        os.path.join(project_dir, "grpc_stubs"),
        os.path.join(project_dir, "docker_container"),
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
    deploy.set_defaults(func=_cmd_deploy)

    # The Kubernetes-only subcommands: build, apply-project, receive, run-gc
    from canyonos_core.kubernetes import commands as kubernetes_commands

    kubernetes_commands.add_parsers(subparsers)

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
