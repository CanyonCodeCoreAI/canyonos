# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Calls each CanyonOS API route with the standard library and returns its answer as
the matching model from `models`."""

import os
import urllib.request
from collections.abc import Iterator
from typing import BinaryIO, TypeVar
from urllib.parse import quote, urlencode

from pydantic import BaseModel

from canyonos_api_interface.models import (
    DashboardBody,
    DashboardWorkflows,
    Generation,
    Health,
    ReplicaLogs,
    Status,
    Uploaded,
    Workflow,
    WorkflowGroupBody,
    WorkflowGroups,
    Workflows,
)

Answer = TypeVar("Answer", bound=BaseModel)
JSON = {"Content-Type": "application/json"}


class Client:
    """Calls the API at `base_url`, such as `http://127.0.0.1:8000`, sending `headers`
    with every request and waiting up to `timeout` seconds (None: no limit). An error
    answer raises urllib's `HTTPError`, its body an `Error`; an answer that isn't its
    route's model raises pydantic's `ValidationError`."""

    def __init__(
        self,
        base_url: str,
        headers: dict[str, str] | None = None,
        timeout: float | None = 60,
    ):
        self.base_url = base_url
        self.headers = headers or {}
        self.timeout = timeout

    def _open(self, method, path, data=None, headers=None):
        """Send `method` to `path` with body `data` and return the open response."""
        request = urllib.request.Request(
            self.base_url + path,
            data=data,
            headers={**self.headers, **(headers or {})},
            method=method,
        )
        return urllib.request.urlopen(request, timeout=self.timeout)

    def _call(
        self, answer: type[Answer], method, path, data=None, headers=None
    ) -> Answer:
        """Send `method` to `path` with body `data` and return the answer as `answer`."""
        with self._open(method, path, data, headers) as response:
            return answer.model_validate_json(response.read())

    def list_workflow_groups(self) -> WorkflowGroups:
        """GET /v1/workflow-groups: the workflow groups the server holds."""
        return self._call(WorkflowGroups, "GET", "/v1/workflow-groups")

    def status(self, workflow_group_id: str) -> Status:
        """GET /v1/workflow-groups/{workflow_group_id}: the workflow group's status."""
        return self._call(Status, "GET", f"/v1/workflow-groups/{workflow_group_id}")

    def put_workflow_group(
        self, workflow_group_id: str, body: WorkflowGroupBody
    ) -> Uploaded:
        """PUT /v1/workflow-groups/{workflow_group_id}: upload workflow_group.yaml and
        its .env."""
        return self._call(
            Uploaded,
            "PUT",
            f"/v1/workflow-groups/{workflow_group_id}",
            body.model_dump_json().encode(),
            JSON,
        )

    def delete_workflow_group(self, workflow_group_id: str) -> Generation:
        """DELETE /v1/workflow-groups/{workflow_group_id}: stop the deploy and remove
        the upload."""
        return self._call(
            Generation, "DELETE", f"/v1/workflow-groups/{workflow_group_id}"
        )

    def list_workflows(self, workflow_group_id: str) -> Workflows:
        """GET /v1/workflow-groups/{workflow_group_id}/workflows: the uploaded
        workflows."""
        return self._call(
            Workflows, "GET", f"/v1/workflow-groups/{workflow_group_id}/workflows"
        )

    def get_workflow(self, workflow_group_id: str, name: str) -> Workflow:
        """GET /v1/workflow-groups/{workflow_group_id}/workflows/{name}: one uploaded
        workflow."""
        return self._call(
            Workflow,
            "GET",
            f"/v1/workflow-groups/{workflow_group_id}/workflows/{quote(name)}",
        )

    def put_workflow(
        self, workflow_group_id: str, name: str, archive: BinaryIO
    ) -> Uploaded:
        """PUT /v1/workflow-groups/{workflow_group_id}/workflows/{name}: upload
        `archive`, an open gzip tar file of the workflow's folder."""
        return self._call(
            Uploaded,
            "PUT",
            f"/v1/workflow-groups/{workflow_group_id}/workflows/{quote(name)}",
            archive,
            # Without a length, urllib sends a file chunked.
            {
                "Content-Type": "application/gzip",
                "Content-Length": str(os.fstat(archive.fileno()).st_size),
            },
        )

    def delete_workflow(self, workflow_group_id: str, name: str) -> Generation:
        """DELETE /v1/workflow-groups/{workflow_group_id}/workflows/{name}: remove a
        workflow."""
        return self._call(
            Generation,
            "DELETE",
            f"/v1/workflow-groups/{workflow_group_id}/workflows/{quote(name)}",
        )

    def controller_log(
        self, workflow_group_id: str, tail: str | int = "all", follow: bool = False
    ) -> Iterator[str]:
        """GET /v1/workflow-groups/{workflow_group_id}/logs/controller: yield the deploy
        process's last `tail` lines, then with `follow` each new one until it exits."""
        query = urlencode({"tail": tail, "follow": str(follow).lower()})
        with self._open(
            "GET", f"/v1/workflow-groups/{workflow_group_id}/logs/controller?{query}"
        ) as response:
            for line in response:
                yield line.decode(errors="replace")

    def health(self, workflow_group_id: str) -> Health:
        """GET /v1/workflow-groups/{workflow_group_id}/health: check the running
        deploy."""
        return self._call(
            Health, "GET", f"/v1/workflow-groups/{workflow_group_id}/health"
        )

    def agent_logs(
        self, workflow_group_id: str, name: str, tail: str | int = "all"
    ) -> ReplicaLogs:
        """GET /v1/workflow-groups/{workflow_group_id}/logs/agents/{name}: the last
        `tail` lines of each replica of agent `name`, or of the replica with that ID."""
        return self._call(
            ReplicaLogs,
            "GET",
            f"/v1/workflow-groups/{workflow_group_id}/logs/agents/{quote(name)}"
            f"?{urlencode({'tail': tail})}",
        )

    def put_dashboard(
        self, workflow_group_id: str, body: DashboardBody
    ) -> DashboardWorkflows:
        """PUT /v1/workflow-groups/{workflow_group_id}/dashboard: register the workflow
        group's Redis with the dashboard api at `body.url`."""
        return self._call(
            DashboardWorkflows,
            "PUT",
            f"/v1/workflow-groups/{workflow_group_id}/dashboard",
            body.model_dump_json().encode(),
            JSON,
        )
