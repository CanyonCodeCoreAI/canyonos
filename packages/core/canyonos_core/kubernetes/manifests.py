# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The Kubernetes objects of a deployment, from its folder: a ConfigMap of its config
files, one CanyonProject and one CanyonAgent per agent.

Rendered next to the schema that checks the file, in the core image: the in-cluster
build applies them after building the images (`canyonos_core.cli apply-project`). Pure:
no cluster or Docker access. The `kubernetes:` settings come parsed, with their
defaults, from schema/kubernetes_block.py.
"""

import os

from canyonos_core.endpoint import endpoint_routes
from canyonos_core.kubernetes.api import (
    API_GROUP,
    API_VERSION,
    MANAGED_BY_LABEL,
    resource_name,
)
from canyonos_core.schema import DEPLOYMENT_CONFIG, project_names
from canyonos_core.schema.kubernetes_block import KubernetesDatabase
from canyonos_core.schema.otel_destinations import LOCAL_DASHBOARD_ENDPOINT

OBJECT_API_VERSION = f"{API_GROUP}/{API_VERSION}"
LABEL_PROJECT = f"{API_GROUP}/project"
# Every apply of a project's objects owns their fields under this name, whether the
# CLI or the in-cluster build applied them.
MANAGED_BY = "canyonos-cli"
FIELD_MANAGER = "canyonos-cli"
DEFAULT_CPU = 1
DEFAULT_MEMORY_MB = 512


def config_folder(workspace):
    """The ConfigMap's contents: the deployment's `deployment.yaml`, and every YAML file
    in each project's config folder as `<project>.<file>`, which run_gc lays out again
    as the deployment's folder for the global controller."""
    with open(os.path.join(workspace, DEPLOYMENT_CONFIG), encoding="utf-8") as f:
        files = {DEPLOYMENT_CONFIG: f.read()}
    for project in project_names(workspace):
        folder = os.path.join(workspace, project, "config")
        for name in sorted(os.listdir(folder)):
            path = os.path.join(folder, name)
            if (
                name.endswith((".yaml", ".yml"))
                and not name.startswith(".")
                and os.path.isfile(path)
            ):
                with open(path, encoding="utf-8") as f:
                    files[f"{project}.{name}"] = f.read()
    return files


# --------------------------------------------------------------------------------
# Rendering the Kubernetes objects
# --------------------------------------------------------------------------------


def _resources(agent_spec):
    """CPU, memory and GPU as Kubernetes limits, matching Docker's `--cpus/--memory`:
    a small CPU request so a small cluster still fits several replicas, memory requested
    in full so pods are not evicted under pressure."""
    configured = agent_spec.get("resources") or {}
    cpu = configured.get("cpu") or DEFAULT_CPU
    memory = configured.get("memory") or DEFAULT_MEMORY_MB
    limits = {"cpu": str(cpu), "memory": f"{int(memory)}Mi"}
    if configured.get("gpu"):
        limits["nvidia.com/gpu"] = str(configured["gpu"])
    return {"limits": limits, "requests": {"cpu": "100m", "memory": f"{int(memory)}Mi"}}


def _placement(spec):
    """Where pods may run: the `node_selector`, or None for anywhere."""
    if not spec.node_selector:
        return None
    return {"nodeSelector": {str(k): str(v) for k, v in spec.node_selector.items()}}


def _project_spec(
    config,
    spec,
    project_id,
    config_map,
    env_secret,
    controller_image,
    name,
    api_key_hash,
):
    redis = spec.redis
    if redis.host:
        redis_spec = {
            "mode": "external",
            "host": redis.host,
            "port": redis.port,
            "tls": redis.tls,
        }
        if redis.password_secret:
            redis_spec["passwordSecretRef"] = redis.password_secret
    else:
        redis_spec = {"mode": "internal", "storage": redis.storage}
        if redis.storage_class:
            redis_spec["storageClassName"] = redis.storage_class

    endpoint = {"routes": endpoint_routes(config)}
    exposure = spec.endpoint
    if exposure.host:
        ingress = {"host": exposure.host}
        if exposure.ingress_class:
            ingress["className"] = exposure.ingress_class
        if exposure.tls_secret:
            ingress["tlsSecretName"] = exposure.tls_secret
        endpoint["ingress"] = ingress
    if exposure.url:
        endpoint["url"] = exposure.url

    project = {
        "projectID": project_id,
        "displayName": name,
        "configRef": config_map,
        "endpoint": endpoint,
        "redis": redis_spec,
        "controllerImage": controller_image,
        "pollIntervalSeconds": max(1, int(config.get("poll_interval", 5) or 5)),
        "logs": bool(config.get("logs", True)),
    }
    if env_secret:
        project["envSecretRef"] = env_secret
    if spec.service_account:
        project["agentServiceAccountName"] = spec.service_account
    if spec.image_pull_secret:
        project["imagePullSecrets"] = [{"name": spec.image_pull_secret}]
    if _placement(spec):
        project["placement"] = _placement(spec)
    if api_key_hash:
        project["auth"] = {"apiKeyHash": api_key_hash}
    return project


def _database_spec(agent_spec, project, spec):
    """A `type: database` agent: its stock image on a disk at `volume_path`, which
    survives a redeploy and the agent's removal, as a Docker volume does; reached by
    other agents through routing on `db_port`. `kubernetes.databases.<name>` gives
    the user IDs the image expects (postgres: 70) and the disk's size."""
    name = agent_spec["name"]
    if not agent_spec.get("volume_path"):
        raise RuntimeError(
            f"{name}: a database on Kubernetes needs volume_path, where its disk is "
            "mounted (for postgres: /var/lib/postgresql/data)"
        )
    settings = spec.databases.get(name) or KubernetesDatabase()
    database = {
        "port": int(agent_spec.get("db_port", 5432)),
        "mountPath": agent_spec["volume_path"],
        "storage": settings.storage,
    }
    if settings.run_as_user is not None:
        database["runAsUser"] = settings.run_as_user
    if settings.fs_group is not None:
        database["fsGroup"] = settings.fs_group
    if settings.storage_class:
        database["storageClassName"] = settings.storage_class
    agent = {
        "projectRef": project,
        "agentName": name,
        "type": "database",
        "image": agent_spec["image"],
        "replicas": 1,  # one copy of its data
        "database": database,
    }
    configured = agent_spec.get("resources") or {}
    if configured.get("cpu") or configured.get("memory"):
        agent["resources"] = _resources(agent_spec)
    return agent


def render(
    config,
    spec,
    *,
    project_name,
    project_id,
    config_files,
    images,
    controller_image,
    env_secret,
    api_key_hash,
    live_replicas=None,
):
    """The Kubernetes objects for one deployment, and warnings about settings Kubernetes
    ignores. `spec` is its parsed `kubernetes:` section; `api_key_hash` is the sha256
    of the API key the deployment's endpoint accepts, "" for none (open). Pure: no
    cluster or Docker access.
    `live_replicas` maps the CanyonAgents the global controller autoscales to their
    live count, which they keep: leaving the count out instead would make the
    server-side apply delete the field it owns, and the CRD default (1) would reset
    the agent."""
    namespace = spec.namespace
    project = resource_name(project_name)
    config_map = f"{project}-config"
    labels = {LABEL_PROJECT: project, MANAGED_BY_LABEL: MANAGED_BY}
    warnings = []

    objects = [
        {
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "metadata": {"name": config_map, "namespace": namespace, "labels": labels},
            "data": config_files,
        },
        {
            "apiVersion": OBJECT_API_VERSION,
            "kind": "CanyonProject",
            "metadata": {"name": project, "namespace": namespace, "labels": labels},
            "spec": _project_spec(
                config,
                spec,
                project_id,
                config_map,
                env_secret,
                controller_image,
                project_name,
                api_key_hash,
            ),
        },
    ]

    for agent_spec in config.get("agents") or []:
        name = agent_spec["name"]
        agent_name = resource_name(name)
        if agent_spec.get("type", "agent") == "database":
            agent = _database_spec(agent_spec, project, spec)
        else:
            if name not in images:
                raise RuntimeError(f"No image was built for {name}")
            agent = {
                "projectRef": project,
                "agentName": name,
                "type": "agent",
                "image": images[name],
                "stateful": bool(agent_spec.get("stateful", False)),
                "resources": _resources(agent_spec),
                # Its project's .env, by the name the CLI's kubernetes_target.py gives it.
                "envSecretRef": spec.env_secret
                or f"{project}-{resource_name(agent_spec['project'])}-env",
            }
            if "agents" in agent_spec:
                agent["hostedAgents"] = [
                    hosted["name"] for hosted in agent_spec["agents"]
                ]
            replicas = agent_spec.get("replicas", 1)
            agent["replicas"] = (live_replicas or {}).get(
                agent_name, replicas if isinstance(replicas, int) else 1
            )
        if agent_spec.get("env"):
            agent["env"] = [
                {"name": str(k), "value": str(v)} for k, v in agent_spec["env"].items()
            ]
        if _placement(spec):
            agent["placement"] = _placement(spec)
        objects.append(
            {
                "apiVersion": OBJECT_API_VERSION,
                "kind": "CanyonAgent",
                "metadata": {
                    "name": agent_name,
                    "namespace": namespace,
                    "labels": labels,
                },
                "spec": agent,
            }
        )

    if config.get("ec2"):
        warnings.append(
            "the ec2: block only applies to EC2 and is ignored on Kubernetes"
        )
    for destination in (config.get("otel") or {}).get("destinations") or []:
        endpoint = str(destination.get("endpoint", ""))
        if "host.docker.internal" in endpoint or endpoint.startswith(
            LOCAL_DASHBOARD_ENDPOINT
        ):
            warnings.append(
                f"otel destination {destination.get('name')!r} points at {endpoint}, "
                "which a cluster does not have: it is skipped there"
            )
    return objects, warnings
