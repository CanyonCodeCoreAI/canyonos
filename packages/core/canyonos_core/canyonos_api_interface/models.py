# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""What each Global Controller server route takes and answers; the server checks
requests against these and builds its OpenAPI spec, at /openapi/openapi.json, from
them."""

from typing import Literal

from flask_openapi3 import RawModel
from pydantic import BaseModel, ConfigDict, Field


class Error(BaseModel):
    """Every error answer; `findings` and `warnings` only come with `project_invalid`."""

    error: str
    code: str
    findings: list[str] | None = None
    warnings: list[str] | None = None


class DeploymentBody(BaseModel):
    """`config` is `deployment.yaml`'s text and `env` the `.env` beside it, null for
    none. `projects`, when given, is every project the deployment has; the uploaded
    projects it leaves out are removed. `api_key_hash`, when given, is the SHA-256 of the
    deploy's API key, "" for none, used only on Kubernetes, where a change restarts the
    deploy."""

    name: str
    config: str
    env: str | None
    projects: list[str] | None = None
    api_key_hash: str | None = None


class DeploymentPath(BaseModel):
    deployment_id: str


class Deployment(BaseModel):
    """`name` is what the deployment's `PUT` last sent, empty before one."""

    deployment_id: str
    name: str


class Deployments(BaseModel):
    deployments: list[Deployment]


class ProjectPath(DeploymentPath):
    # Python's regex engine, for the look-ahead that refuses `.` and `..`.
    model_config = ConfigDict(regex_engine="python-re")

    name: str = Field(pattern=r"^(?!\.\.?$)[^/]+$")


class ProjectArchive(RawModel):
    """A gzip tar of a project's folder, paths relative to it, with its `.env`."""

    mimetypes = ["application/gzip"]


class Generation(BaseModel):
    generation: int


class Uploaded(Generation):
    """`warnings` name problems in the upload that don't stop the deploy."""

    warnings: list[str]


class DashboardBody(BaseModel):
    """`url` is the dashboard api's address as this container reaches it."""

    url: str


class DashboardProject(BaseModel):
    project_id: str
    name: str


class TailQuery(BaseModel):
    # Matched here because the agent logs route puts it in a shell command remotely.
    tail: str = Field("all", pattern=r"^(\d+|all)$")


class LogsQuery(TailQuery):
    follow: bool = False


class AgentPath(DeploymentPath):
    name: str


class SlowestStep(BaseModel):
    name: str
    seconds: float


class Route(BaseModel):
    project: str
    agent: str
    method: str
    arguments: list[str]
    url: str


class Endpoint(BaseModel):
    public_host: str
    api_port: int
    routes: list[Route]


class Agent(BaseModel):
    desired_replicas: int
    running_replicas: int
    launch_error: str | None


class LastApply(BaseModel):
    """What the apply loop last did to bring the deploy in line with `generation`."""

    generation: int
    action: Literal["none", "start", "restart", "reload", "stop"]
    ok: bool
    error: str | None
    code: (
        Literal[
            "config_invalid",
            "reload_failed",
            "reload_timeout",
            "stop_timeout",
            "stop_failed",
        ]
        | None
    )


class Status(BaseModel):
    """`name` and `config` are what the deployment's `PUT` last sent, without the `.env`;
    `running` is whether the deploy process is alive, so a failed deploy can still be
    running while it stops itself."""

    version: str
    name: str
    config: str | None
    running: bool
    phase: Literal["starting", "up", "failed", "stopped"] | None
    message: str | None
    steps: list[str]
    slowest_step: SlowestStep | None
    idle_seconds: float | None
    error: str | None
    error_code: (
        Literal[
            "deploy_failed",
            "deploy_incomplete",
            "deploy_stopped_early",
            "deploy_timeout",
            "controller_exited",
        ]
        | None
    )
    root_cause: str | None
    endpoint: Endpoint | None
    agents: dict[str, Agent] | None
    machine_errors: dict[str, str] | None
    generation: int
    applied_generation: int
    applying: Literal["start", "restart", "reload", "stop"] | None
    last_apply: LastApply | None
    errors: list[str]


class Check(BaseModel):
    name: str
    ok: bool
    detail: str
    fix: str | None


class Health(BaseModel):
    ok: bool
    checks: list[Check]


class ReplicaLogs(BaseModel):
    logs: dict[str, list[str]]


class Fingerprints(BaseModel):
    """Digests over a project's uploaded files: `config` over its `config/` files and
    `.env`, which a reload applies, and `code` over the rest."""

    code: str
    config: str


class Project(BaseModel):
    """`test_query` is its `config/test_query.txt`, null when it has none."""

    name: str
    fingerprints: Fingerprints
    test_query: str | None


class Projects(BaseModel):
    projects: list[Project]


TEXT = {"content": {"text/plain": {"schema": {"type": "string"}}}}
