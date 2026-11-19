# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Shared request helpers for the Global Controller container, so the commands
that talk to it don't each restate the same routes, payloads and failure modes.
"""

import json
import urllib.error
import urllib.request

from canyonos_api_interface.client import Client
from canyonos_api_interface.models import DashboardBody, WorkflowGroupBody

from canyonos import deployment, env
from canyonos.init import load_state

REQUEST_TIMEOUT_SECONDS = 60
# Longer than the server's wait for the deploy to stop, which drains every replica first.
CLEAN_REQUEST_TIMEOUT_SECONDS = 270
# Longer than one log read on a replica's machine, which may take up to 180s over SSH.
LOGS_REQUEST_TIMEOUT_SECONDS = 200
# Longer than the server's minute of retries to reach the dashboard api.
DASHBOARD_REQUEST_TIMEOUT_SECONDS = 90


class GCError(RuntimeError):
    """A failed Global Controller request, carrying a message fit to print, the HTTP
    status as `code`, the controller's `error_code` and, for a rejected workflow, its
    `findings` and `warnings`."""

    def __init__(self, message, code=None, findings=(), error_code=None, warnings=()):
        super().__init__(message)
        self.code = code
        self.error_code = error_code
        self.findings = findings
        self.warnings = warnings


def _error_body(e):
    """The server's JSON error object; `{"error": <raw body>}` when it isn't one with
    an `error` field."""
    body = e.read().decode(errors="replace").strip()
    try:
        parsed = json.loads(body)
    except ValueError:
        parsed = None
    if isinstance(parsed, dict) and parsed.get("error"):
        return parsed
    return {"error": body or f"HTTP {e.code}"}


def _request(action, call, *args):
    """Make `call`, a Global Controller `Client` request, with `args` and return its
    answer as a dict; any failure is raised as `GCError`."""
    try:
        return call(*args).model_dump(mode="json")
    except urllib.error.HTTPError as e:
        body = _error_body(e)
        raise GCError(
            f"{action} failed: {body['error']}",
            code=e.code,
            findings=body.get("findings", ()),
            error_code=body.get("code"),
            warnings=body.get("warnings", ()),
        ) from None
    except urllib.error.URLError as e:
        raise GCError(
            f"Could not reach Global Controller container: {e.reason}"
        ) from None
    except (TimeoutError, OSError) as e:
        raise GCError(f"Could not reach Global Controller container: {e}") from None
    # A body that isn't JSON or isn't the route's answer model.
    except ValueError:
        raise GCError(
            f"{action} failed: Global Controller returned an invalid response"
        ) from None


class NoDeployError(RuntimeError):
    """No deploy of this workflow group is running; `canyonos` exits with 3."""

    exit_code = 3
    error_code = "no_deploy"


def require_state():
    """Recorded container state; raise NoDeployError when there is none."""
    try:
        return load_state()
    except FileNotFoundError:
        raise NoDeployError(
            "No workflow group is running. Run `canyonos deploy <workflow folder>...` "
            "first."
        ) from None


def existing_deploy():
    """The running deploy's state if one is already up, else None."""
    try:
        state = load_state()
    except FileNotFoundError:
        return None
    if (deploy_status(state) or {}).get("running", False):
        return state
    return None


def put_workflow_group(state, config, env, workflows=None, api_key_hash=None):
    """Upload the workflow group's name, the text `config` of its `workflow_group.yaml`
    and the text `env` of the `.env` beside it (None when there is none); with
    `workflows`, the container removes the uploaded workflows not among them; with
    `api_key_hash`, the
    SHA-256 of the deploy's API key ("" for none), it keeps that as the deploy's key.
    Return the new generation and the upload's warnings. Raises GCError on failure."""
    client = Client(
        f"http://127.0.0.1:{state['port']}",
        state.get("headers"),
        REQUEST_TIMEOUT_SECONDS,
    )
    body = WorkflowGroupBody(
        name=deployment.folder_name(),
        config=config,
        env=env,
        workflows=workflows,
        api_key_hash=api_key_hash,
    )
    return _request("Sync", client.put_workflow_group, state["workflow_group_id"], body)


def put_workflow(state, name, archive):
    """Make `archive`, an open gzip tar file of workflow `name`'s folder, that workflow's
    files in the container and return the new generation and the upload's warnings.
    Raises GCError on failure, with the `findings` `canyonos validate` would print when
    the workflow breaks the contract."""
    client = Client(
        f"http://127.0.0.1:{state['port']}",
        state.get("headers"),
        REQUEST_TIMEOUT_SECONDS,
    )
    return _request(
        "Sync", client.put_workflow, state["workflow_group_id"], name, archive
    )


def put_dashboard(state, url):
    """Have the Global Controller register its Redis with the dashboard api at `url`,
    the address the controller reaches it at, and return the api's `{workflow_id,
    name}` of each workflow under `workflows`. Raises GCError on failure."""
    client = Client(
        f"http://127.0.0.1:{state['port']}",
        state.get("headers"),
        DASHBOARD_REQUEST_TIMEOUT_SECONDS,
    )
    return _request(
        "Dashboard registration",
        client.put_dashboard,
        state["workflow_group_id"],
        DashboardBody(url=url),
    )


def list_workflow_groups(port, headers):
    """Return the workflow groups the Global Controller on `port` holds, each with its
    `workflow_group_id` and `name`, sending it `headers`. Raises GCError on failure."""
    client = Client(f"http://127.0.0.1:{port}", headers, REQUEST_TIMEOUT_SECONDS)
    return _request("List workflow groups", client.list_workflow_groups)[
        "workflow_groups"
    ]


def delete_workflow_group(state):
    """Stop the running deploy and remove every upload, waiting until the deploy has
    stopped. This is what removes the local controller and Redis containers a deploy
    spawned via docker-outside-of-docker."""
    client = Client(
        f"http://127.0.0.1:{state['port']}",
        state.get("headers"),
        CLEAN_REQUEST_TIMEOUT_SECONDS,
    )
    return _request("Stop", client.delete_workflow_group, state["workflow_group_id"])


def deploy_status(state):
    """The deploy's GET /v1/workflow-groups/<workflow_group_id>: whether it runs, its phase, progress, verdict,
    endpoint, agents and what the last apply did. None when the container can't be
    read; raises GCError when it runs another CanyonOS release than this CLI, outside
    development.

    A malformed body is as uninformative as an unreachable one, so both answer
    None rather than raising at a caller whose contract is "couldn't tell".
    """
    url = (
        f"http://127.0.0.1:{state['port']}/v1/workflow-groups/"
        f"{state['workflow_group_id']}"
    )
    request = urllib.request.Request(url, headers=state.get("headers", {}))
    try:
        with urllib.request.urlopen(request, timeout=5) as resp:
            status = json.loads(resp.read())
    except (OSError, ValueError, TypeError):
        return None
    if not isinstance(status, dict):
        return None
    # A checkout's CLI runs whatever core image it is pointed at, as on Kubernetes.
    if not env.is_development and status.get("version") != env.VERSION:
        raise GCError(
            "This workflow group's Global Controller runs CanyonOS "
            f"{status.get('version') or 'an older release'} and this CLI is "
            f"{env.VERSION}. Run `canyonos deploy <workflow folder>...` to restart it on "
            f"{env.VERSION}.",
            error_code="version_mismatch",
        )
    return status


def deployed_endpoint(state):
    """Return the endpoint record the running deploy published (`public_host`,
    `api_port`, and `routes`, each with its `agent`, `method`, `arguments` and `url`);
    raise GCError when the deploy has none yet."""
    endpoint = (deploy_status(state) or {}).get("endpoint")
    if endpoint is None:
        raise GCError(
            "The running deploy has no endpoint yet. Run `canyonos status` to see "
            "when it is up."
        )
    return endpoint


def test_queries(state):
    """Return the query each uploaded workflow ships in its `config/test_query.txt`, by
    workflow, leaving out a workflow with none, from the workflow group's workflows;
    raise GCError when the container can't say."""
    client = Client(f"http://127.0.0.1:{state['port']}", state.get("headers"), 10)
    workflows = _request(
        "Read test queries", client.list_workflows, state["workflow_group_id"]
    )["workflows"]
    return {
        workflow["name"]: workflow["test_query"]
        for workflow in workflows
        if workflow["test_query"]
    }


def deploy_health(state):
    """Return GET .../health for `canyonos doctor`: `ok`, and under `checks`
    each part of the running deploy with its `name`, `ok`, `detail` and `fix`; raise
    GCError when the container can't say, including when no deploy runs."""
    client = Client(
        f"http://127.0.0.1:{state['port']}",
        state.get("headers"),
        REQUEST_TIMEOUT_SECONDS,
    )
    return _request("Health check", client.health, state["workflow_group_id"])


def controller_log(state, tail="all", follow=False):
    """Yield the deploy process's own output from its controller log, line by line:
    its last `tail` lines, then with `follow` each new one until the deploy exits.
    Raises GCError when the container can't be read."""
    client = Client(
        f"http://127.0.0.1:{state['port']}",
        state.get("headers"),
        # A deploy can print nothing for minutes, so a followed log has no timeout.
        None if follow else REQUEST_TIMEOUT_SECONDS,
    )
    try:
        yield from client.controller_log(state["workflow_group_id"], tail, follow)
    except OSError as e:
        raise GCError(f"Could not read the Global Controller log: {e}") from None


def deployed_logs(state, name, tail):
    """Return the last `tail` lines of each running replica of agent `name`, or of the
    one replica whose ID is `name`, keyed by replica ID; raise GCError when the
    container can't say, naming the agents when `name` is neither."""
    client = Client(
        f"http://127.0.0.1:{state['port']}",
        state.get("headers"),
        LOGS_REQUEST_TIMEOUT_SECONDS,
    )
    replica_logs = _request(
        "Read logs", client.agent_logs, state["workflow_group_id"], name, tail
    )
    return replica_logs["logs"]
