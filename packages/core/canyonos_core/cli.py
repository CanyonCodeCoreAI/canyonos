"""
CanyonOS CLI

Entry point for the `canyonos` command. Provides these subcommands:
    canyonos new-project <name>   — Scaffold a new CanyonOS project
    canyonos deploy               — Build (stubs + Docker images) then launch
                                  agents via the Global Controller
"""

import argparse
import glob
import json
import logging
import os
import shutil
import subprocess
import sys

from canyonos_core.controller.utils.config_env import (
    expand_env_value,
    load_root_dotenv,
)
from canyonos_core.controller.utils.env_file import resolve_env_file
from canyonos_core.schema import (
    DependencyPinConflict,
    load_manifest,
    render_violation,
    validate_project,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("canyonos_core")
DEFAULT_DOCKER_PLATFORM = "linux/amd64"
ARTIFACT_DIR_NAME = ".car"
SOURCE_DIR_NAME = "app"


# ------------------------------------------------------------------ #
#  Helpers                                                             #
# ------------------------------------------------------------------ #


def _get_templates_dir():
    """Return the absolute path to the bundled templates directory."""
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "templates")


def _get_package_dir():
    """Return the absolute path to the canyonos package directory."""
    return os.path.dirname(os.path.abspath(__file__))


def _load_config(config_path):
    """Load the config as the schema checked it and the controller will read it.

    The root `.env` is imported and `${VAR}` refs are expanded through the
    same helper both of those use. Reading the raw YAML here instead let a
    reference the schema had validated in its expanded form reach the build
    as the literal `${VAR}`.
    """
    import yaml

    load_root_dotenv(config_path)
    with open(config_path, "r") as f:
        config = expand_env_value(yaml.safe_load(f))
    # Everything below here till "return config" is basically just checks to make sure the folder is correct
    if not isinstance(config, dict):
        raise RuntimeError(f"Config must contain a YAML mapping: {config_path}")
    agents = config.get("agents", [])
    if not isinstance(agents, list) or not all(
        isinstance(agent, dict) for agent in agents
    ):
        raise RuntimeError(f"Config `agents` must be a list of mappings: {config_path}")
    names = [agent.get("name") for agent in agents]
    if any(not isinstance(name, str) or not name.strip() for name in names):
        raise RuntimeError(
            f"Every configured agent must have a non-empty name: {config_path}"
        )
    names_by_key = {}
    for name in names:
        names_by_key.setdefault(name.casefold(), []).append(name)
    duplicates = sorted(
        "/".join(group) for group in names_by_key.values() if len(group) > 1
    )
    if duplicates:
        raise RuntimeError(
            f"Duplicate agent names in {config_path}: {', '.join(duplicates)}"
        )

    for agent in agents:
        name = agent["name"]
        provider = agent.get("provider", "local")
        if not isinstance(provider, str) or provider.casefold() not in {"local", "ec2"}:
            raise RuntimeError(
                f"Agent {name} has unsupported provider {provider!r}; use `local` or `EC2`."
            )
        agent["provider"] = "EC2" if provider.casefold() == "ec2" else "local"

        replicas = agent.get("replicas", 1)
        if isinstance(replicas, bool) or not isinstance(replicas, int) or replicas < 1:
            raise RuntimeError(
                f"Agent {name} must have a positive integer `replicas` value."
            )
        if (
            agent["provider"] == "local"
            and agent.get("type", "agent") == "workflow"
            and replicas > 1
        ):
            raise RuntimeError(
                f"Local workflow {name} cannot use replicas > 1 because every replica "
                "would publish the same `api_port`."
            )

        for field in ("host_port", "port", "redis_port", "api_port", "dashboard_port"):
            value = agent.get(field)
            if value is not None and (
                isinstance(value, bool)
                or not isinstance(value, int)
                or not 1 <= value <= 65535
            ):
                raise RuntimeError(
                    f"Agent {name} must have an integer `{field}` between 1 and 65535."
                )

        resources = agent.get("resources", {})
        if not isinstance(resources, dict):
            raise RuntimeError(f"Agent {name} `resources` must be a mapping.")
        for field in ("cpu", "memory", "gpu"):
            value = resources.get(field)
            if value is not None and (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or value <= 0
            ):
                raise RuntimeError(
                    f"Agent {name} resource `{field}` must be a positive number."
                )
    return config


def _artifact_prefix(root):
    return (
        ARTIFACT_DIR_NAME
        if os.path.isdir(os.path.join(root, ARTIFACT_DIR_NAME))
        else ""
    )


def _project_layout():
    """(artifact_root, source_root, declarations_dir) for the project in cwd.

    The .car layout keeps the app's own code under `.car/app` and everything
    generated beside it; a plain checkout keeps both at the project root.
    """
    project_dir = os.path.abspath(os.getcwd())
    prefix = _artifact_prefix(project_dir)
    artifact_root = os.path.join(project_dir, prefix) if prefix else project_dir
    return (
        artifact_root,
        os.path.join(artifact_root, SOURCE_DIR_NAME) if prefix else project_dir,
        os.path.join(artifact_root, "config" if prefix else "agents"),
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


def validate_or_exit(config_path, declarations_dir, source_dir=None):
    """Reject the config before anything is generated; return the parsed manifest."""
    violations = validate_project(config_path, declarations_dir, source_dir)
    if violations:
        _reject(
            violations,
            "Configuration rejected: %d problem(s) found; nothing was built.",
        )
    return load_manifest(config_path)


def _normalize_requirements(agent_cfg):
    """Return a service's `requirements` list; the schema already checked its shape."""
    return list(agent_cfg.get("requirements") or [])


def _check_dependency_pins(manifest):
    """Fail the build when an app pin cannot share a version with a platform pin.

    Every service is checked before the first one is built, so a project with
    two bad pins is told about both instead of one per run.
    """
    from canyonos_core.stub_generator import _platform_overrides

    violations = []
    for index, service in enumerate(manifest.agents):
        try:
            _platform_overrides(
                getattr(service, "requirements", ()),
                service=index,
                manifest_path=manifest.path,
            )
        except DependencyPinConflict as conflict:
            violations.extend(conflict.violations)

    if violations:
        _reject(
            violations,
            "Dependency pins rejected: %d conflict(s) found; nothing was built.",
        )


def _docker_platform():
    """Return the target Docker platform for portable runtime images."""
    return os.environ.get("CANYONOS_DOCKER_PLATFORM", DEFAULT_DOCKER_PLATFORM)


def _docker_build_cmd(*args):
    """Build a Docker build command with an explicit target platform."""
    return ["docker", "build", "--platform", _docker_platform(), *args]


def _docker_available(probe_cmd=("docker", "info")):
    if not shutil.which("docker"):
        return False

    try:
        result = subprocess.run(
            list(probe_cmd),
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return False

    return result.returncode == 0


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


def _require_docker_for_ec2(command_name):
    if _docker_available():
        return
    raise RuntimeError(
        f"EC2-backed `canyonos {command_name}` requires local Docker, but Docker is unavailable "
        "or unreachable."
    )


def _ensure_grpc_stubs_importable(project_dir):
    grpc_stubs_dir = os.path.join(project_dir, "grpc_stubs")
    if grpc_stubs_dir not in sys.path:
        sys.path.insert(0, grpc_stubs_dir)

    try:
        __import__("local_controler_pb2")
        __import__("local_controler_pb2_grpc")
    except ImportError as exc:
        raise RuntimeError(
            "Deploy failed: generated grpc_stubs are missing or not importable. "
            "Run `canyonos build` on this host first."
        ) from exc


def _preflight_ec2_deploy(config, project_dir):
    # The required `ec2:` keys are the manifest schema's job, checked before
    # anything was built; what is left here is the local toolchain.
    _require_docker_for_ec2("deploy")
    _ensure_grpc_stubs_importable(project_dir)


# ------------------------------------------------------------------ #
#  canyonos new-project                                                  #
# ------------------------------------------------------------------ #


def cmd_new_project(args):
    """Scaffold a new CanyonOS project."""
    project_name = args.name
    project_dir = os.path.abspath(project_name)

    if os.path.exists(project_dir):
        logger.error("Directory '%s' already exists.", project_name)
        sys.exit(1)

    templates_dir = _get_templates_dir()
    if not os.path.isdir(templates_dir):
        logger.error("Templates directory not found at %s", templates_dir)
        sys.exit(1)

    # Copy the entire templates tree into .car/app, then pull config and agent
    # declarations up into .car/config, keeping generated artifacts (stubs,
    # grpc_stubs, docker_container) siblings of the source under .car/.
    artifact_root = os.path.join(project_dir, ARTIFACT_DIR_NAME)
    source_root = os.path.join(artifact_root, SOURCE_DIR_NAME)
    shutil.copytree(templates_dir, source_root)

    source_config = os.path.join(source_root, "config")
    artifact_config = os.path.join(artifact_root, "config")
    if os.path.isdir(source_config):
        shutil.move(source_config, artifact_root)
    else:
        os.makedirs(artifact_config)

    source_agents = os.path.join(source_root, "agents")
    for declaration in glob.glob(os.path.join(source_agents, "*.yaml")):
        shutil.move(declaration, artifact_config)

    readme = os.path.join(source_root, "README.md")
    if os.path.isfile(readme):
        shutil.move(readme, project_dir)

    # Create empty output directories
    os.makedirs(os.path.join(artifact_root, "stubs"), exist_ok=True)
    os.makedirs(os.path.join(artifact_root, "grpc_stubs"), exist_ok=True)

    logger.info("Created new CanyonOS project: %s", project_dir)
    logger.info("")
    logger.info("  cd %s", project_name)
    logger.info("  canyonos deploy")


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

    artifact_root, source_root, declarations_dir = _project_layout()

    # Nothing below this line runs against a config the schema rejects: no
    # stubs, no protoc, no Docker context, no image. It comes before the load
    # so a file that is not YAML at all is rendered as a violation too, and it
    # is handed source_root so a service whose code is missing fails here
    # rather than being skipped out of a deploy that then reports success.
    manifest = validate_or_exit(config_path, declarations_dir, source_root)
    _check_dependency_pins(manifest)

    config = _load_config(config_path)
    agents = config.get("agents", [])
    package_dir = _get_package_dir()

    # -------------------------------------------------------------- #
    #  Step 1: Discover agent YAML files and generate Python stubs    #
    # -------------------------------------------------------------- #
    stubs_dir = os.path.join(artifact_root, "stubs")
    os.makedirs(stubs_dir, exist_ok=True)

    from canyonos_core.stub_generator import (
        generate_stub,
        generate_docker,
        generate_workflow_docker,
    )

    yaml_files = glob.glob(os.path.join(declarations_dir, "*.yaml"))
    if not yaml_files:
        logger.warning("No agent YAML files found in %s", declarations_dir)

    import yaml

    # Looks up a config entry's YAML and to map stubs to entrypoints.
    yaml_by_name = {}
    for yaml_path in yaml_files:
        with open(yaml_path) as f:
            name = yaml.safe_load(f).get("agent", {}).get("name")
        if name:
            yaml_by_name[name] = yaml_path

    # Maps each generated stub's basename to its agent's entrypoint path, which
    # is the single location the stub is written to and copied to.
    entrypoints_by_name = {a["name"]: a.get("entrypoint") for a in agents}
    missing_stubs = [
        a["name"]
        for a in agents
        if a.get("type", "agent") not in ("workflow", "database")
        and (a["name"] not in yaml_by_name or not a.get("entrypoint"))
    ]
    if missing_stubs:
        logger.error("Cannot generate stubs for agents: %s", ", ".join(missing_stubs))
        sys.exit(1)

    # Keyed by the stub's own basename, which is the entrypoint's: the stub is
    # written to `stubs/<entrypoint>` below.
    stub_entrypoints = {
        os.path.basename(entrypoints_by_name[n]): entrypoints_by_name[n]
        for n in yaml_by_name
        if entrypoints_by_name.get(n)
    }

    stub_paths = []
    for agent_name, yaml_path in yaml_by_name.items():
        entrypoint = entrypoints_by_name.get(agent_name)
        if not entrypoint:
            continue
        output_path = os.path.join(stubs_dir, entrypoint)
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        logger.info("Generating stub: %s -> %s", yaml_path, output_path)
        generate_stub(yaml_path, output_path)
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
    bake_targets = []
    for agent_cfg in agents:
        agent_name = agent_cfg["name"]
        agent_type = agent_cfg.get("type", "agent")

        if agent_type == "database":
            # No build: pull the declared image and tag it like any other
            # agent image so the rest of the deploy pipeline treats it the
            # same way (EC2 image transfer, etc.) without further changes.
            image = agent_cfg["image"]
            target_image = f"canyonos-{agent_name.lower()}"
            logger.info("Pulling database image '%s' as '%s'", image, target_image)
            subprocess.run(
                ["docker", "pull", "--platform", _docker_platform(), image], check=True
            )
            subprocess.run(["docker", "tag", image, target_image], check=True)
            continue

        # Every key read below is one the schema requires and has checked,
        # down to the file being on disk -- a service that cannot be built
        # fails the deploy rather than dropping quietly out of it.
        if agent_type == "workflow":
            # Workflow container
            workflow_path = os.path.join(source_root, agent_cfg["workflow_file"])
            docker_context = os.path.join(artifact_root, "docker_container", "Workflow")
            logger.info("Generating workflow Docker context for '%s'", agent_name)
            generate_workflow_docker(
                workflow_path,
                stub_paths,
                output_dir=docker_context,
                grpc_stubs_dir=grpc_stubs_dir,
                api_port=agent_cfg.get("api_port", 8080),
                project_dir=source_root,
                requirements=_normalize_requirements(agent_cfg),
                # Stubs are placed both flat and at their entrypoint-mirrored path,
                # so both flat and nested import styles resolve to the stub.
                stub_entrypoints=stub_entrypoints,
            )

        else:
            # Agent container
            agent_file = os.path.join(source_root, agent_cfg["entrypoint"])

            # Find matching YAML by agent name
            matching_yaml = yaml_by_name.get(agent_name)
            if not matching_yaml:
                logger.warning(
                    "No YAML definition found for agent '%s', skipping Docker",
                    agent_name,
                )
                continue

            docker_context = os.path.join(artifact_root, "docker_container", agent_name)
            logger.info("Generating Docker context for '%s'", agent_name)
            generate_docker(
                matching_yaml,
                agent_file,
                output_dir=docker_context,
                grpc_stubs_dir=grpc_stubs_dir,
                stub_files=stub_paths,
                project_dir=source_root,
                requirements=_normalize_requirements(agent_cfg),
                # Same reasoning as the workflow call above: stubs are placed both
                # flat and at their entrypoint-mirrored path.
                stub_entrypoints=stub_entrypoints,
            )

        bake_targets.append(
            {
                "name": agent_name.lower(),
                "context": docker_context,
                "image_name": f"canyonos-{agent_name.lower()}",
            }
        )

    # -------------------------------------------------------------- #
    #  Step 5: Build all Docker images                                #
    # -------------------------------------------------------------- #
    if not bake_targets:
        logger.info("No Docker images to build.")
    elif _docker_available() and _docker_available(("docker", "buildx", "version")):
        docker_container_dir = os.path.join(artifact_root, "docker_container")
        os.makedirs(docker_container_dir, exist_ok=True)
        bake_file_path = os.path.join(docker_container_dir, "docker-bake.json")
        _write_bake_file(bake_targets, bake_file_path, _docker_platform())

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
                _docker_build_cmd("-t", target["image_name"], target["context"]),
                check=True,
            )

    logger.info("Build complete.")


# ------------------------------------------------------------------ #
#  canyonos deploy                                                       #
# ------------------------------------------------------------------ #


def cmd_deploy(args):
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

    config = _load_config(config_path)
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

    if any(
        agent.get("provider", "local").upper() == "EC2"
        for agent in config.get("agents", [])
    ):
        _preflight_ec2_deploy(config, artifact_root)

    from canyonos_core.controller.global_controller import GlobalController

    controller = GlobalController(config_path)

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
    controller.launch_docker_agents()
    controller._wait_for_healthy()
    controller.run()


# ------------------------------------------------------------------ #
#  canyonos clean                                                        #
# ------------------------------------------------------------------ #


def cmd_clean(args):
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
    default_config_path = os.path.join(
        _artifact_prefix(os.getcwd()), "config", "global_controller.yaml"
    )
    parser = argparse.ArgumentParser(
        prog="canyonos_core",
        description="CanyonOS — Distributed Agent Orchestration Framework",
    )
    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # canyonos new-project <name>
    new_proj = subparsers.add_parser(
        "new-project",
        help="Scaffold a new CanyonOS project",
    )
    new_proj.add_argument("name", help="Name of the project directory to create")
    new_proj.set_defaults(func=cmd_new_project)

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
    deploy.set_defaults(func=cmd_deploy)

    # canyonos clean
    clean = subparsers.add_parser(
        "clean",
        help="Remove generated stubs, compiled protos, and Docker contexts",
    )
    clean.set_defaults(func=cmd_clean)

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(1)

    args.func(args)


if __name__ == "__main__":
    main()
