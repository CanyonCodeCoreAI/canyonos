# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The `canyonos_core` subcommands that run only on Kubernetes, which `cli.main`
registers: `build` and `apply-project` (the in-cluster build Job), `receive` (its
upload), `run-gc` (the Global Controller's pod), and `kubernetes-plan` and
`bundle-workspace`, which the CanyonOS API's job worker runs to start a build."""

import json
import logging
import os
import subprocess
import sys
import tarfile

from canyonos_core.cli import (
    _checked_config,
    _generate_build_contexts,
    _show_result,
    _validate_or_exit,
    _write_bake_file,
)
from canyonos_core.controller.utils.config_env import read_dotenv
from canyonos_core.kubernetes.api import KubernetesApi, resource_name
from canyonos_core.schema import (
    DEPLOYMENT_CONFIG,
    SchemaError,
    check_deployment,
    load_deployment_config,
    SchemaViolation,
    render_violation,
    workflow_names,
)
from canyonos_core.schema.kubernetes_block import MISSING_SECTION_HINT

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
    workspace = os.path.dirname(os.path.abspath(args.config))
    manifest, config = _checked_config(workspace)
    bake_targets = _generate_build_contexts(manifest, config, workspace)
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
    workspace,
    project_name,
    images,
    controller_image,
    env_secret,
    api_key_hash,
    live_replicas,
    namespace=None,
):
    """The deployment's Kubernetes objects and warnings, from its folder `workspace`,
    checked by the schema first. `api_key_hash` is the hash of the API key its endpoint
    accepts, "" for none. `namespace` overrides `kubernetes.namespace` (the namespace the in-cluster
    build runs in)."""
    import dataclasses

    from canyonos_core.kubernetes import manifests

    config = load_deployment_config(workspace)
    spec = _validate_or_exit(workspace).kubernetes
    if spec is None:
        raise RuntimeError(
            f"{workspace}/{DEPLOYMENT_CONFIG} has no kubernetes: section"
        )
    if namespace:
        spec = dataclasses.replace(spec, namespace=namespace)
    if not config.get("workflow_group_id"):
        raise RuntimeError(f"{workspace}/{DEPLOYMENT_CONFIG} has no workflow_group_id")
    return manifests.render(
        config,
        spec,
        project_name=project_name,
        project_id=str(config["workflow_group_id"]),
        config_files=manifests.config_folder(workspace),
        images=images,
        controller_image=controller_image,
        env_secret=env_secret or None,
        api_key_hash=api_key_hash,
        live_replicas=live_replicas,
    )


def _read_images(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)["images"]


def _cmd_apply_project(args):
    """Render the project's objects and apply them in this pod's namespace, then delete
    the CanyonAgents of agents no longer in the config. The in-cluster build runs this
    after pushing the images, with a Role the operator gives it, and the API key hash
    of its CanyonBuild in its environment, which the CanyonProject carries on."""
    from canyonos_core.auth import api_key_hash_from_env
    from canyonos_core.kubernetes import manifests

    api = KubernetesApi.from_environment()
    project = resource_name(args.project)
    existing = {
        agent["metadata"]["name"]: agent.get("spec", {}).get("replicas")
        for agent in api.canyon_agents(project)
    }
    workspace = os.path.dirname(os.path.abspath(args.config))
    files = manifests.config_folder(workspace)
    # An autoscaled agent keeps the count the global controller gave it: the apply sets
    # that live count. (A /scale between this read and the apply is undone until the
    # global controller's next decision.)
    live = {}
    if any(name.endswith(".scaling.yaml") for name in files):
        live = {name: count for name, count in existing.items() if count is not None}
    try:
        objects, warnings = _render_project(
            workspace,
            args.project,
            _read_images(args.images),
            os.environ.get("CANYONOS_CORE_IMAGE", ""),
            args.env_secret,
            api_key_hash_from_env(os.environ),
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


def kubernetes_plan(workspace, name):
    """Check the workflow group in `workspace`, named `name`, and return what the
    CanyonOS API needs to build it in the cluster: its `kubernetes:` settings, the
    Secrets to apply with the `.env` values of the group and of each workflow, its
    project label and its workflows. Raise CommandError with every violation when the
    schema rejects it or it has no `kubernetes:` section."""
    from canyonos_core.workspace_jobs import CommandError

    manifest, violations = check_deployment(workspace)
    spec = manifest and manifest.kubernetes
    if not violations and spec is None:
        violations = (
            SchemaViolation(
                os.path.join(workspace, DEPLOYMENT_CONFIG),
                0,
                "kubernetes",
                f"is missing -- {MISSING_SECTION_HINT}",
            ),
        )
    if violations or spec is None:
        raise CommandError(
            str(SchemaError(violations)),
            violations=[render_violation(violation) for violation in violations],
        )
    try:
        project = resource_name(name)
    except ValueError:
        raise CommandError(
            f"The workflow group's name {name!r} has no letters or digits to name its "
            "Kubernetes objects by."
        ) from None
    env = read_dotenv(os.path.join(workspace, ".env"))
    workflows = list(workflow_names(workspace))
    secrets = {}
    if not spec.env_secret:
        # Each workflow's agents get its own .env, by the name manifests.py gives it.
        secrets = {
            f"{project}-{resource_name(workflow)}-env": read_dotenv(
                os.path.join(workspace, workflow, ".env")
            )
            for workflow in workflows
        }
        if env:
            secrets[f"{project}-env"] = env
    return {
        "ok": True,
        "namespace": spec.namespace,
        "registry": spec.registry,
        "platform": spec.platform,
        "image_pull_secret": spec.image_pull_secret,
        "env_secret": spec.env_secret or (f"{project}-env" if env else None),
        "secrets": secrets,
        "project": project,
        "workflows": workflows,
    }


# What the CanyonOS API keeps in a workflow group's folder for itself, such as what
# each upload unpacked; the build has no use for it.
API_FOLDER = ".canyonos"


def _without_env(info):
    """Leave every `.env` file out of the bundle, in any case: its values reach the
    build and the agents as Secrets instead."""
    name = os.path.basename(info.name).casefold()
    return None if name.startswith(".env") else info


def bundle_workspace(workspace, out):
    """Write the workflow group in `workspace` as a gzipped tar to `out`, for the build
    pod's upload, without its `.env` files and the API's own folder; return its path
    and size. Raise CommandError when it can't be written."""
    from canyonos_core.workspace_jobs import CommandError

    out, workspace = os.path.abspath(out), os.path.abspath(workspace)
    if os.path.commonpath([out, workspace]) == workspace:
        raise CommandError(f"{out} is inside the workflow group's folder {workspace}.")
    try:
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with tarfile.open(f"{out}.tmp", mode="w:gz") as tar:
            for entry in sorted(os.listdir(workspace)):
                if entry != API_FOLDER:
                    tar.add(os.path.join(workspace, entry), entry, filter=_without_env)
        os.replace(f"{out}.tmp", out)
    except OSError as e:
        if os.path.lexists(f"{out}.tmp"):
            os.remove(f"{out}.tmp")
        raise CommandError(f"Could not bundle the workflow group: {e}") from None
    return {"path": out, "bytes": os.path.getsize(out)}


def _cmd_kubernetes_plan(args):
    """Show, as JSON on stdout, what the CanyonOS API builds the workflow group in the
    current folder with on Kubernetes, or every reason it can't be built there."""
    _show_result(kubernetes_plan, os.getcwd(), args.name)


def _cmd_bundle_workspace(args):
    """Write the workflow group in the current folder to --out for a build pod's
    upload, and show its path and size as JSON on stdout."""
    _show_result(bundle_workspace, os.getcwd(), args.out)


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
        default=DEPLOYMENT_CONFIG,
        help=f"Path to the deployment's config (default: {DEPLOYMENT_CONFIG})",
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
    apply_project.add_argument("-c", "--config", default=DEPLOYMENT_CONFIG)
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
        default=DEPLOYMENT_CONFIG,
        help=f"Path to the deployment's config (default: {DEPLOYMENT_CONFIG})",
    )
    run_gc.set_defaults(func=_cmd_run_gc)

    # canyonos_core kubernetes-plan: what the CanyonOS API builds a workflow group with
    kubernetes_plan = subparsers.add_parser(
        "kubernetes-plan",
        help="Show the workflow group's Kubernetes settings and Secrets, as JSON",
    )
    kubernetes_plan.add_argument(
        "--name", required=True, help="The workflow group's name"
    )
    kubernetes_plan.set_defaults(func=_cmd_kubernetes_plan)

    # canyonos_core bundle-workspace: the workflow group for a build pod's upload
    bundle_workspace = subparsers.add_parser(
        "bundle-workspace",
        help="Write the workflow group without its .env files as a gzip tar, as JSON",
    )
    bundle_workspace.add_argument(
        "--out", required=True, help="The gzip tar to write, outside the folder"
    )
    bundle_workspace.set_defaults(func=_cmd_bundle_workspace)
