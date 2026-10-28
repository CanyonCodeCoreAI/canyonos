# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The `canyonos_core` subcommands that run only on Kubernetes, which `cli.main`
registers: `build` and `apply-project` (the in-cluster build Job), `receive` (its
upload) and `run-gc` (the Global Controller's pod)."""

import json
import logging
import os
import subprocess
import sys

from canyonos_core.cli import (
    _checked_config,
    _generate_build_contexts,
    _validate_or_exit,
    _write_bake_file,
)
from canyonos_core.controller.utils.config_env import load_config
from canyonos_core.kubernetes.api import KubernetesApi, resource_name
from canyonos_core.schema import CONFIG_PATH

logger = logging.getLogger(__name__)

# The buildx builder `canyonos_core build --builder` registers for a remote BuildKit.
REMOTE_BUILDER = "canyonos-remote"


def _bake_remote(
    bake_targets, project_dir, platform, address, push_registry, pull_registry, tag
):
    """Build every image on the BuildKit daemon at `address` and push it from there to
    `push_registry`; return {service: pull_registry/image@digest}, the digests read from
    bake's metadata. The two registries are one registry under the names the builder
    and the nodes reach it by (kind: kind-registry:5000 and localhost:5001)."""
    if not bake_targets:
        return {}
    known = subprocess.run(
        ["docker", "buildx", "inspect", REMOTE_BUILDER], capture_output=True, text=True
    )
    if known.returncode:
        subprocess.run(
            [
                "docker",
                "buildx",
                "create",
                "--name",
                REMOTE_BUILDER,
                "--driver",
                "remote",
                address,
            ],
            check=True,
        )
    docker_container_dir = os.path.join(project_dir, "docker_container")
    os.makedirs(docker_container_dir, exist_ok=True)
    bake_file_path = os.path.join(docker_container_dir, "docker-bake.json")
    metadata_path = os.path.join(docker_container_dir, "bake-metadata.json")
    _write_bake_file(
        bake_targets, bake_file_path, platform, push_to=(push_registry, tag)
    )
    logger.info("Building %d image(s) on %s.", len(bake_targets), address)
    subprocess.run(
        [
            "docker", "buildx", "bake", "--builder", REMOTE_BUILDER,
            "--file", bake_file_path, "--metadata-file", metadata_path,
            *[target["name"] for target in bake_targets],
        ],
        check=True,
        # Unchanged code must keep its digest; the default provenance differs per build.
        env={**os.environ, "BUILDX_NO_DEFAULT_ATTESTATIONS": "1"},
    )  # fmt: skip
    with open(metadata_path, encoding="utf-8") as f:
        metadata = json.load(f)
    images = {}
    for target in bake_targets:
        digest = metadata.get(target["name"], {}).get("containerimage.digest")
        if not digest:
            raise RuntimeError(
                f"The builder reported no digest for {target['service']}"
            )
        images[target["service"]] = (
            f"{pull_registry.rstrip('/')}/{target['image_name']}@{digest}"
        )
    return images


def _cmd_build(args):
    """Build the project's images on the cluster's BuildKit (--builder) and push them to
    --registry; write each service's digest-pinned reference to --output-json. The
    in-cluster build Job runs this; there is no Docker daemon in its pod."""
    bake_targets = _generate_build_contexts(*_checked_config(args.config))
    from canyonos_core.stub_generator import this_machine_platform

    # The project's `kubernetes.platform`, else the nodes' own (this pod's): there is
    # no Docker daemon here to ask, and agents run on the cluster, not a host.
    platform = os.environ.get("CANYONOS_DOCKER_PLATFORM") or this_machine_platform()
    images = _bake_remote(
        bake_targets,
        os.getcwd(),
        platform,
        args.builder,
        args.push_registry or args.registry,
        args.registry,
        args.tag,
    )
    with open(args.output_json, "w", encoding="utf-8") as f:
        json.dump({"images": images}, f, indent=2)
    logger.info("Pushed %d image(s) to %s", len(images), args.registry)


def _render_project(
    config_path,
    project_name,
    images,
    controller_image,
    env_secret,
    live_replicas,
    namespace=None,
):
    """The project's Kubernetes objects and warnings, from its config, checked by the
    schema first. `namespace` overrides `kubernetes.namespace` (the namespace the
    in-cluster build runs in)."""
    import dataclasses

    from canyonos_core.kubernetes import manifests

    config = load_config(config_path)
    spec = _validate_or_exit(config_path).kubernetes
    if spec is None:
        raise RuntimeError(f"{config_path} has no kubernetes: section")
    if namespace:
        spec = dataclasses.replace(spec, namespace=namespace)
    if not config.get("project_id"):
        raise RuntimeError(f"{config_path} has no project_id")
    return manifests.render(
        config,
        spec,
        project_name=project_name,
        project_id=str(config["project_id"]),
        config_files=manifests.config_folder(config_path),
        images=images,
        controller_image=controller_image,
        env_secret=env_secret or None,
        live_replicas=live_replicas,
    )


def _read_images(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)["images"]


def _cmd_apply_project(args):
    """Render the project's objects and apply them in this pod's namespace, then delete
    the CanyonAgents of agents no longer in the config. The in-cluster build runs this
    after pushing the images, with a Role the operator gives it."""
    from canyonos_core.kubernetes import manifests

    api = KubernetesApi.from_environment()
    project = resource_name(args.project)
    existing = {
        agent["metadata"]["name"]: agent.get("spec", {}).get("replicas")
        for agent in api.canyon_agents(project)
    }
    files = manifests.config_folder(args.config)
    # An autoscaled agent keeps the count the global controller gave it: the apply sets
    # that live count. (A /scale between this read and the apply is undone until the
    # global controller's next decision.)
    live = {}
    if "scaling.yaml" in files:
        live = {name: count for name, count in existing.items() if count is not None}
    try:
        objects, warnings = _render_project(
            args.config,
            args.project,
            _read_images(args.images),
            os.environ.get("CANYONOS_CORE_IMAGE", ""),
            args.env_secret,
            live,
            namespace=api.namespace,
        )
    except (RuntimeError, ValueError) as e:
        logger.error("%s", e)
        sys.exit(1)
    for warning in warnings:
        logger.warning("%s", warning)
    for obj in objects:
        api.apply(obj, manifests.FIELD_MANAGER)
        logger.info("Applied %s %s", obj["kind"], obj["metadata"]["name"])
    wanted = {
        obj["metadata"]["name"] for obj in objects if obj["kind"] == "CanyonAgent"
    }
    for name in existing:
        if name not in wanted:
            api.delete_canyon_agent(name)
            logger.info("Removed service %s", name)


def _cmd_receive(args):
    """Take one upload of the project (a gzipped tar, by HTTP PUT) into --dest, then
    exit 0; exit 1 when none arrives within --timeout. The build Job runs this first;
    `canyonos deploy --target kubernetes` uploads through a port-forward, so no one
    needs exec rights on the pod."""
    from canyonos_core.kubernetes.receiver import receive_upload

    sys.exit(0 if receive_upload(args.dest, args.port, args.timeout) else 1)


def _cmd_run_gc(args):
    """Run the Global Controller on its own, as a Kubernetes pod (kubernetes/run_gc.py)."""
    from canyonos_core.kubernetes import run_gc

    if not os.path.isfile(args.config):
        logger.error("Config file not found: %s", args.config)
        sys.exit(1)
    run_gc.run(args.config)


def add_parsers(subparsers):
    """Add the Kubernetes subcommands to `canyonos_core`'s parser."""
    # canyonos_core build: a Kubernetes deploy's images, built and pushed in the cluster
    build = subparsers.add_parser(
        "build",
        help="Build the project's images on a remote BuildKit and push them",
    )
    build.add_argument(
        "-c",
        "--config",
        default=CONFIG_PATH,
        help=f"Path to global controller config (default: {CONFIG_PATH})",
    )
    build.add_argument(
        "--builder", required=True, help="The BuildKit to build on (tcp://host:1234)"
    )
    build.add_argument(
        "--registry", required=True, help="Registry the nodes pull the images from"
    )
    build.add_argument(
        "--push-registry",
        help="The registry as the builder reaches it, when it names it differently",
    )
    build.add_argument("--tag", default="latest", help="Tag for the pushed images")
    build.add_argument(
        "--output-json", required=True, help="Write {service: image@digest} here"
    )
    build.set_defaults(func=_cmd_build)

    # canyonos_core apply-project: apply the project's Kubernetes objects
    apply_project = subparsers.add_parser(
        "apply-project", help="Apply the project's Kubernetes objects here"
    )
    apply_project.add_argument("-c", "--config", default=CONFIG_PATH)
    apply_project.add_argument(
        "--images", required=True, help="{images: {agent: ref}} JSON"
    )
    apply_project.add_argument("--project", required=True, help="The project's name")
    apply_project.add_argument(
        "--env-secret", default="", help="Secret with the .env values"
    )
    apply_project.set_defaults(func=_cmd_apply_project)

    # canyonos_core receive: take a project upload in a build pod
    receive = subparsers.add_parser(
        "receive", help="Wait for the project's upload into --dest, then exit"
    )
    receive.add_argument("--dest", required=True, help="Folder to unpack into")
    receive.add_argument("--port", type=int, default=8090)
    receive.add_argument("--timeout", type=int, default=900, help="Seconds to wait")
    receive.set_defaults(func=_cmd_receive)

    # canyonos_core run-gc: the Global Controller alone, as a Kubernetes pod
    run_gc = subparsers.add_parser(
        "run-gc",
        help="Run only the Global Controller, on Kubernetes (no build, no containers)",
    )
    run_gc.add_argument(
        "-c",
        "--config",
        default=CONFIG_PATH,
        help=f"Path to global controller config (default: {CONFIG_PATH})",
    )
    run_gc.set_defaults(func=_cmd_run_gc)
