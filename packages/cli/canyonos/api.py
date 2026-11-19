# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
The CanyonOS API's `/v1/workflow-groups` routes, so the commands that deploy, stop and
read a workflow group don't each restate the same routes, payloads and failure modes.

On Docker the API is the local stack's (`dashboard_stack`), on 127.0.0.1 at its host
port, and every call sends this machine's control key; the API runs each workflow
group's Global Controller container through Docker. On Kubernetes it is the cluster's,
the one the operator's chart installs, reached through a port-forward with the user's
kubectl login (`kubernetes_target.kubernetes_state`); it runs each workflow group as a
CanyonProject. Both answer the same routes and shapes, and an error is
`{error, message, findings?, warnings?}`.
"""

import json
import os
import urllib.error
import urllib.parse
import urllib.request

from canyonos import deployment, env
from canyonos.auth import control_header
from canyonos.init import load_state

REQUEST_TIMEOUT_SECONDS = 60
STATUS_TIMEOUT_SECONDS = 5
# Longer than the API's wait for the deploy to stop, which drains every replica first:
# on Docker, and on Kubernetes, where it waits up to 15 minutes for the operator.
CLEAN_REQUEST_TIMEOUT_SECONDS = 270
KUBERNETES_CLEAN_REQUEST_TIMEOUT_SECONDS = 905
# Longer than one log read on a replica's machine, which may take up to 180s over SSH.
LOGS_REQUEST_TIMEOUT_SECONDS = 200
# Longer than the API's own wait for the dashboard to take the registration.
DASHBOARD_REQUEST_TIMEOUT_SECONDS = 90

PREFIX = "/v1/workflow-groups"
# The CanyonOS API names its errors `workflow_groups.<code>`.
ERROR_PREFIX = "workflow_groups."
UNKNOWN_WORKFLOW_GROUP = "unknown_workflow_group"
# What an older chart's API answers on Kubernetes: no route there (a release before
# the /v1 routes), or the /v1 routes of an API that drives only Docker, without Docker
# or the control key.
OLDER_CHART_ERRORS = {
    404: (None, "not_found"),
    503: ("docker.disabled",),
    401: ("auth.control_key_unset",),
}

# Where the CanyonOS API answers on this machine, found once per command: the
# commands that start it (`serve.ensure_api`) forget it, since it may move.
_docker_url = None


class ApiError(RuntimeError):
    """A failed CanyonOS API request, carrying a message fit to print, the HTTP
    `status` the API answered (None when it could not be reached), its error `code`
    without the `workflow_groups.` prefix and, for a rejected workflow, its `findings`
    and `warnings`."""

    def __init__(self, message, status=None, code=None, findings=(), warnings=()):
        super().__init__(message)
        self.status = status
        self.code = code
        self.findings = findings
        self.warnings = warnings

    @property
    def error_code(self):
        """The code `--json` reports for this failure."""
        return self.code


class NoDeployError(RuntimeError):
    """No deploy of this workflow group is running; `canyonos` exits with 3."""

    exit_code = 3
    error_code = "no_deploy"


def docker_api_url():
    """Where the CanyonOS API answers on this machine: the port its running container
    publishes, else the one it starts on next."""
    global _docker_url
    if _docker_url is None:
        # Imported here: the stack's module reads ports this one has no need of.
        from canyonos.dashboard_stack import running_api_port, service_ports

        _docker_url = f"http://127.0.0.1:{running_api_port() or service_ports()['api']}"
    return _docker_url


def forget_api_url():
    """Find the CanyonOS API again on the next call, after it was started or moved."""
    global _docker_url
    _docker_url = None


def _on_kubernetes(state):
    """Whether `state`'s workflow group is reached through the cluster's API."""
    return bool(state and "api_url" in state)


def _connection(state):
    """The base URL and headers a call about `state`'s workflow group goes to: the
    cluster's API on Kubernetes, else this machine's with the control key; this
    machine's when `state` is None."""
    if _on_kubernetes(state):
        return state["api_url"], state["api_headers"]
    return docker_api_url(), control_header()


def error_detail(body, status):
    """The error object of an answer's `body`, raw bytes, as `{error, code, findings,
    warnings}`, `error` its message and `code` its code without the prefix, from the
    CanyonOS API's `{error: code, message}`; the raw body as `error` when it is not
    that."""
    text = body.decode(errors="replace").strip()
    try:
        parsed = json.loads(text)
    except ValueError:
        parsed = None
    if not isinstance(parsed, dict) or not parsed.get("error"):
        return {
            "error": text or f"HTTP {status}",
            "code": None,
            "findings": (),
            "warnings": (),
        }
    return {
        "error": parsed.get("message") or str(parsed["error"]),
        "code": str(parsed["error"]).removeprefix(ERROR_PREFIX),
        "findings": parsed.get("findings") or (),
        "warnings": parsed.get("warnings") or (),
    }


def _open(state, method, path, action, data=None, headers=None, timeout=None):
    """Send `method` to `path` of the API `state`'s workflow group is reached at and
    return the open response; any failure is raised as `ApiError`."""
    base_url, auth = _connection(state)
    request = urllib.request.Request(
        f"{base_url}{path}",
        data=data,
        headers={**auth, **(headers or {})},
        method=method,
    )
    try:
        return urllib.request.urlopen(request, timeout=timeout)
    except urllib.error.HTTPError as e:
        detail = error_detail(e.read(), e.code)
        message = detail["error"]
        if _on_kubernetes(state) and detail["code"] in OLDER_CHART_ERRORS.get(
            e.code, ()
        ):
            # Imported here: kubernetes_target imports this module.
            from canyonos.kubernetes_target import UPGRADE_CHART

            message = f"{UPGRADE_CHART} (the cluster's API answered: {message})"
        raise ApiError(
            f"{action} failed: {message}",
            status=e.code,
            code=detail["code"],
            findings=detail["findings"],
            warnings=detail["warnings"],
        ) from None
    except TimeoutError:
        raise ApiError(
            f"{action} failed: the CanyonOS API at {base_url} did not answer within "
            f"{timeout}s"
        ) from None
    except OSError as e:
        reason = getattr(e, "reason", e)
        hint = (
            ""
            if _on_kubernetes(state)
            else "Run `canyonos deploy` or `canyonos serve` to start it."
        )
        raise ApiError(
            f"Could not reach the CanyonOS API at {base_url}: {reason}. {hint}".strip()
        ) from None


def _request(
    state,
    method,
    path,
    action,
    body=None,
    timeout=REQUEST_TIMEOUT_SECONDS,
    archive=None,
):
    """Call the API with `body` as JSON, or the open file `archive` as a gzip upload,
    and return its JSON answer as a dict; any failure is raised as `ApiError`."""
    data, headers = None, {}
    if body is not None:
        data, headers = json.dumps(body).encode(), {"Content-Type": "application/json"}
    elif archive is not None:
        # Without a length, urllib sends a file chunked.
        data = archive
        headers = {
            "Content-Type": "application/gzip",
            "Content-Length": str(os.fstat(archive.fileno()).st_size),
        }
    with _open(state, method, path, action, data, headers, timeout) as response:
        try:
            answer = json.loads(response.read())
        except (OSError, ValueError):
            answer = None
    if not isinstance(answer, dict):
        raise ApiError(
            f"{action} failed: the CanyonOS API returned an invalid response"
        )
    return answer


def _quoted(name):
    return urllib.parse.quote(name, safe="")


def _group_path(state, route=""):
    """The path of `state`'s workflow group, with `route` under it."""
    return f"{PREFIX}/{_quoted(state['workflow_group_id'])}{route}"


def require_state():
    """Recorded container state; raise NoDeployError when there is none. On Docker the
    CanyonOS API is started when it is down, so the command can ask it."""
    try:
        state = load_state()
    except FileNotFoundError:
        raise NoDeployError(
            "No workflow group is running. Run `canyonos deploy <workflow folder>...` "
            "first."
        ) from None
    start_api_for(state)
    return state


def start_api_for(state):
    """Start the CanyonOS API when it is down and the Global Controller container
    `state` records is on this machine, so a command that only reads can ask it. A
    running API is left as it is, and one that won't start is left to the request that
    follows to report."""
    if _on_kubernetes(state):
        return
    # Imported here: serve imports this module.
    from canyonos.serve import start_api_if_down

    start_api_if_down(state)


def existing_deploy():
    """The running deploy's state if one is already up, else None."""
    try:
        state = load_state()
    except FileNotFoundError:
        return None
    start_api_for(state)
    if is_running(workflow_group_status(state)):
        return state
    return None


def is_running(status):
    """Whether the deploy a status answer describes runs; False for None."""
    return bool(status and status.get("running"))


def list_workflow_groups(state=None):
    """Return the workflow groups the API holds or finds a Global Controller of, each
    with its `workflow_group_id` and `name`; this machine's API without `state`.
    Raises ApiError on failure."""
    return _request(state, "GET", PREFIX, "List workflow groups")["workflow_groups"]


def probe(state=None):
    """Check that the API answers `/v1`, so a command fails at once, naming the fix,
    when it runs an older image without these routes. Raises ApiError."""
    try:
        list_workflow_groups(state)
    except ApiError as e:
        if e.status != 404:
            raise
        raise ApiError(
            f"The CanyonOS API at {_connection(state)[0]} has no {PREFIX} routes: it "
            f"runs an older image than this CLI ({env.api_image}). In a checkout, build "
            "it with `bun run canyonos:dev` or point CANYONOS_API_IMAGE at an image "
            "built from it.",
            status=404,
            code=e.code,
        ) from None


def put_workflow_group(state, config, env_text, workflows=None, api_key_hash=None):
    """Upload the workflow group's name, the text `config` of its `workflow_group.yaml`
    and the text `env_text` of the `.env` beside it (None when there is none); with
    `workflows`, the API removes the uploaded workflows not among them; with
    `api_key_hash`, the SHA-256 of the deploy's API key ("" for none), it keeps that as
    the deploy's key. Return the new generation and the upload's warnings. Raises
    ApiError on failure."""
    body = {
        "name": deployment.folder_name(),
        "config": config,
        "env": env_text,
        "workflows": workflows,
        "api_key_hash": api_key_hash,
    }
    return _request(state, "PUT", _group_path(state), "Sync", body)


def put_workflow(state, name, archive):
    """Make `archive`, an open gzip tar file of workflow `name`'s folder, that workflow's
    files in the Global Controller's workspace and return the new generation and the
    upload's warnings. Raises ApiError on failure, with the `findings` `canyonos
    validate` would print when the workflow breaks the contract."""
    return _request(
        state,
        "PUT",
        _group_path(state, f"/workflows/{_quoted(name)}"),
        "Sync",
        archive=archive,
    )


def put_dashboard(state):
    """Have the API register the workflow group's Redis with the dashboard and return
    the dashboard's `{workflow_id, name}` of each workflow under `workflows`. Raises
    ApiError on failure."""
    return _request(
        state,
        "PUT",
        _group_path(state, "/dashboard"),
        "Dashboard registration",
        timeout=DASHBOARD_REQUEST_TIMEOUT_SECONDS,
    )


def delete_workflow_group(state):
    """Stop the workflow group's deploy and remove every upload, waiting until the deploy
    has stopped: what removes the replicas and Redis it started. Raises ApiError on
    failure."""
    return _request(
        state,
        "DELETE",
        _group_path(state),
        "Stop",
        timeout=KUBERNETES_CLEAN_REQUEST_TIMEOUT_SECONDS
        if _on_kubernetes(state)
        else CLEAN_REQUEST_TIMEOUT_SECONDS,
    )


def workflow_group_status(state):
    """The workflow group's status: whether its deploy runs, its phase, progress,
    verdict, endpoint, agents and what the last apply did; None when the API knows no
    such workflow group. Raises ApiError when the API can't say, and when the Global
    Controller runs another CanyonOS release than this CLI, outside development."""
    try:
        status = _request(
            state,
            "GET",
            _group_path(state),
            "Read deploy status",
            timeout=STATUS_TIMEOUT_SECONDS,
        )
    except ApiError as e:
        if e.code == UNKNOWN_WORKFLOW_GROUP:
            return None
        raise
    version = status.get("version")
    # A checkout's CLI runs whatever core image it is pointed at, as on Kubernetes.
    # A Global Controller that has not reported yet has no version to compare.
    if not env.is_development and version is not None and version != env.VERSION:
        # On Kubernetes it is the cluster's API's, the chart's, which a deploy keeps.
        if _on_kubernetes(state):
            runs = "The cluster's CanyonOS API runs"
            fix = f"Upgrade the CanyonOS operator chart to {env.VERSION}."
        else:
            runs = "This workflow group's Global Controller runs"
            fix = (
                f"Run `canyonos deploy <workflow folder>...` to restart it on "
                f"{env.VERSION}."
            )
        raise ApiError(
            f"{runs} CanyonOS {version or 'an older release'} and this CLI is "
            f"{env.VERSION}. {fix}",
            code="version_mismatch",
        )
    return status


def deploy_status(state):
    """`workflow_group_status` for a caller that polls: None also when the API can't be
    reached or read, which the poll counts as a miss. Still raises ApiError for a
    Global Controller of another release."""
    try:
        return workflow_group_status(state)
    except ApiError as e:
        if e.code == "version_mismatch":
            raise
        return None


def deployed_endpoint(state):
    """Return the endpoint record the running deploy published (`public_host`,
    `api_port`, and `routes`, each with its `agent`, `method`, `arguments` and `url`);
    raise ApiError when the deploy has none yet."""
    endpoint = (workflow_group_status(state) or {}).get("endpoint")
    if endpoint is None:
        raise ApiError(
            "The running deploy has no endpoint yet. Run `canyonos status` to see "
            "when it is up."
        )
    return endpoint


def test_queries(state):
    """Return the query each uploaded workflow ships in its `config/test_query.txt`, by
    workflow, leaving out a workflow with none; raise ApiError when the API can't
    say."""
    workflows = _request(
        state, "GET", _group_path(state, "/workflows"), "Read test queries", timeout=10
    )["workflows"]
    return {
        workflow["name"]: workflow["test_query"]
        for workflow in workflows
        if workflow["test_query"]
    }


def deploy_health(state):
    """Return the health of the running deploy for `canyonos doctor`: `ok`, and under
    `checks` each part of it with its `name`, `ok`, `detail` and `fix`; raise ApiError
    when the API can't say, including when no deploy runs."""
    return _request(state, "GET", _group_path(state, "/health"), "Health check")


def controller_log(state, tail="all", follow=False):
    """Yield the deploy's own output from its Global Controller log, line by line: its
    last `tail` lines, then with `follow` each new one until the deploy exits. Raises
    ApiError when the log can't be read."""
    query = urllib.parse.urlencode({"tail": tail, "follow": str(follow).lower()})
    response = _open(
        state,
        "GET",
        _group_path(state, f"/logs/controller?{query}"),
        "Read the Global Controller log",
        # A deploy can print nothing for minutes, so a followed log has no timeout.
        timeout=None if follow else REQUEST_TIMEOUT_SECONDS,
    )
    try:
        with response:
            for line in response:
                yield line.decode(errors="replace")
    except OSError as e:
        raise ApiError(f"Could not read the Global Controller log: {e}") from None


def deployed_logs(state, name, tail):
    """Return the last `tail` lines of each running replica of agent `name`, or of the
    one replica whose ID is `name`, keyed by replica ID; raise ApiError when the API
    can't say, naming the agents when `name` is neither."""
    query = urllib.parse.urlencode({"tail": tail})
    return _request(
        state,
        "GET",
        _group_path(state, f"/logs/agents/{_quoted(name)}?{query}"),
        "Read logs",
        timeout=LOGS_REQUEST_TIMEOUT_SECONDS,
    )["logs"]
