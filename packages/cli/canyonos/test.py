# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos test`: send one prompt to each workflow the deployment running
from this folder serves, and report what each answered. It deploys nothing: run
`canyonos deploy <project folder>...` first.
"""

import json
import sys
import time
import urllib.error
import urllib.request

from rich.panel import Panel
from rich.text import Text

from canyonos import kubernetes_target, ui
from canyonos.deploy import (
    _curl_example,
)
from canyonos.gc import _error_detail, deployed_endpoint, existing_deploy, test_queries
from canyonos.os_support import is_terminal
from canyonos.theme import GREEN, WHITE

DEFAULT_QUERY = "hello"
REQUEST_TIMEOUT = 300
SUBMIT_TIMEOUT = 30
POLL_INTERVAL = 2


def _send_query(url, body):
    """POST a query or an answer to the endpoint and return the request ID it sends back."""
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=SUBMIT_TIMEOUT) as resp:
        payload = resp.read()
    try:
        return json.loads(payload)["request_id"]
    except (ValueError, KeyError, TypeError) as e:
        raise RuntimeError(
            f"The workflow accepted the request but returned an unexpected response "
            f"(no request_id): {e}"
        ) from None


def _await_result(endpoint, request_id, timeout):
    """Poll the endpoint until the request is done, errors or waits for an answer, or
    return `{"status": "timeout"}`."""
    url = f"http://{endpoint['public_host']}:{endpoint['api_port']}/status/{request_id}"
    deadline = time.time() + timeout
    with ui.status("Running query..."):
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(url, timeout=10) as resp:
                    data = json.loads(resp.read())
                if data.get("status") in ("done", "error", "input_required"):
                    return data
            except (OSError, ValueError):
                # A network blip or a malformed body while the workflow is busy; keep polling.
                pass
            time.sleep(POLL_INTERVAL)
    return {"status": "timeout"}


class _Run:
    """One `canyonos test` invocation: the phases it got through, and what they found."""

    def __init__(self, query):
        # The query given on the command line, sent to every route in place of its own.
        self.query = query
        self.started = time.monotonic()
        self.phases = []
        # The URL of each route queried so far, the query it was sent, and the result
        # of each that answered.
        self.endpoints = []
        self.queries = []
        self.results = []
        self.request_id = None
        self.answer_url = None
        self.error = None

    def begin(self, name, title):
        """Open a phase, recorded as failed until `done` says otherwise."""
        self.phases.append({"name": name, "ok": False, "detail": None})
        ui.blank()
        ui.say(title)

    def done(self, detail=None):
        """Mark the current phase passed, with a short detail for the summary."""
        self.phases[-1].update(ok=True, detail=detail)

    def failed(self, detail):
        """Record the error on the current phase."""
        if self.phases:
            self.phases[-1]["detail"] = detail

    def elapsed(self):
        """Return seconds since the test started."""
        return round(time.monotonic() - self.started, 3)


def _read_answer(prompt, kind):
    """Read one answer to the workflow's question from the terminal: as typed when
    `kind` is `str`, otherwise as JSON when it parses and as typed when it doesn't."""
    text = input(prompt)
    if kind == "str":
        return text
    try:
        return json.loads(text)
    except ValueError:
        return text


def _query(run, endpoint, timeout, queries):
    """Send every route of the deployed endpoint a test query: the one given on the
    command line, else its project's in `queries`, else DEFAULT_QUERY. Stores each
    result on the run; raises if one errors or times out."""
    run.begin("query", "Query the workflows")
    for route in endpoint["routes"]:
        query = run.query or queries.get(route.get("project")) or DEFAULT_QUERY
        _query_route(run, endpoint, route, query, timeout)
    run.done(f"{len(run.results)} workflow(s) answered in {run.elapsed()}s")


def _query_route(run, endpoint, route, query, timeout):
    """Send `query` to one route, as every argument of its method, and store the result
    on the run; raises if it errors or times out."""
    body = {name: query for name in route["arguments"]}
    url = route["url"]
    run.endpoints.append(url)
    run.queries.append(query)
    ui.say(f"POST {url}  {json.dumps(body)}")

    try:
        request_id = _send_query(url, body)
    except urllib.error.HTTPError as e:
        detail = _error_detail(e)
        if e.code == 403:
            raise RuntimeError(
                f"Workflow query was refused: {detail}. "
                "Run `canyonos status` to check the deploy."
            ) from None
        raise RuntimeError(f"Workflow query failed: {detail}") from None
    except OSError as e:
        raise RuntimeError(f"Could not reach the workflow at {url}: {e}") from None

    data = _await_result(endpoint, request_id, timeout)
    answer_url = (
        f"http://{endpoint['public_host']}:{endpoint['api_port']}/answer/{request_id}"
    )
    while data.get("status") == "input_required":
        asked = data["question"]
        schema = asked["input_schema"]
        # Quiet means --json, which can't show the question; with no terminal, no one can type.
        if ui.console.quiet or not is_terminal(sys.stdin):
            run.request_id, run.answer_url = request_id, answer_url
            example = {key: f"<{kind}>" for key, kind in schema.items()}
            raise RuntimeError(
                f"The workflow asks {json.dumps(asked['question'])}, but `canyonos test` can "
                "only take an answer typed in a terminal, without --json. The deploy stays "
                f"up, so answer request {request_id} with: {_curl_example(answer_url, example)}"
            )
        ui.say(f"The workflow asks: {json.dumps(asked['question'])}")
        body = {}
        for key, kind in schema.items():
            prompt = f"{key} ({kind}): "
            if list(schema) == ["input"]:
                prompt = "Your answer: " if kind == "str" else f"Your answer ({kind}): "
            body[key] = _read_answer(prompt, kind)
        try:
            _send_query(answer_url, body)
        except urllib.error.HTTPError as e:
            raise RuntimeError(
                f"Could not send the answer to {answer_url}: {_error_detail(e)}"
            ) from None
        except OSError as e:
            raise RuntimeError(
                f"Could not send the answer to {answer_url}: {e}"
            ) from None
        data = _await_result(endpoint, request_id, timeout)
    status = data.get("status")
    if status == "error":
        raise RuntimeError(data.get("error") or "the workflow returned an error.")
    if status != "done":
        raise RuntimeError(f"The workflow did not finish within {timeout}s.")

    run.results.append(data.get("result"))


def _run_test(run, timeout=REQUEST_TIMEOUT, kubernetes=False):
    """Query each workflow of the deployment running from this folder, or, on
    Kubernetes, of the project deployed in the cluster, through a port-forward."""
    if kubernetes:
        with kubernetes_target.kubernetes_endpoint() as endpoint:
            _query(run, endpoint, timeout, {})
        return

    existing = existing_deploy()
    if existing is None:
        raise RuntimeError(
            "No deployment is running from this folder. Run it from the deployment's "
            "folder, the one `canyonos deploy --folder` made."
        )
    _query(
        run,
        deployed_endpoint(existing["port"]),
        timeout,
        test_queries(existing["port"]),
    )


# ------------------------------------------------------------------ #
#  Output                                                             #
# ------------------------------------------------------------------ #


def _summary_body(run):
    """Build the text of the `canyonos test` results panel: what ran, and the result."""
    body = Text()
    for index, (url, query) in enumerate(zip(run.endpoints, run.queries)):
        if index:
            body.append("\n")
        body.append("Endpoint   ", "dim")
        body.append(url, WHITE)
        body.append("\nInput      ", "dim")
        body.append(query, WHITE)
    body.append("\nElapsed    ", "dim")
    body.append(f"{run.elapsed()}s", WHITE)

    body.append("\n")
    for phase in run.phases:
        body.append("\n")
        body.append("✓ " if phase["ok"] else "✗ ", GREEN if phase["ok"] else "bold red")
        body.append(f"{phase['name']:<16}", WHITE)
        # The failing phase's detail is the error, spelled out below in full.
        body.append(phase["detail"] if phase["ok"] else "", "dim")

    body.append("\n\n")
    if run.error is None:
        for index, (url, result) in enumerate(zip(run.endpoints, run.results)):
            if index:
                body.append("\n\n")
            body.append("Output     ", "dim")
            if len(run.results) > 1:
                body.append(f"{url}\n", "dim")
            body.append(json.dumps(result, indent=2), WHITE)
    else:
        body.append(run.error, "bold red")
    return body


def _print_summary(run):
    """Show the pass/fail results panel in the terminal when `canyonos test` ends."""
    passed = run.error is None
    ui.blank()
    ui.panel(
        Panel(
            _summary_body(run),
            title=f"[bold {GREEN}]Test passed[/]"
            if passed
            else "[bold red]Test failed[/]",
            title_align="left",
            border_style=GREEN if passed else "red",
            padding=(1, 4),
        )
    )
    ui.blank()


def _payload(run):
    return {
        "ok": run.error is None,
        "query": run.query,
        "elapsed_s": run.elapsed(),
        "phases": run.phases,
        "results": [
            {"url": url, "query": query, "result": result}
            for url, query, result in zip(run.endpoints, run.queries, run.results)
        ],
        "request_id": run.request_id,
        "answer_url": run.answer_url,
        "error": run.error,
    }


def run_test(prompt=None, as_json=False, timeout=REQUEST_TIMEOUT, kubernetes=False):
    """Run `canyonos test`: query each workflow of the running deployment, report the
    results, and return the exit code."""
    run = _Run(prompt)
    ui.set_quiet(as_json)

    try:
        try:
            _run_test(run, timeout=timeout, kubernetes=kubernetes)
        except KeyboardInterrupt:
            run.error = "cancelled by user"
        except EOFError:
            run.error = (
                "The workflow asked a question, but there is no terminal to answer it."
            )
        except RuntimeError as e:
            # Every phase raises RuntimeError with a message fit for the terminal and `--json`.
            run.error = str(e)

        if run.error is not None:
            run.failed(run.error)

        if as_json:
            print(json.dumps(_payload(run), indent=2))
        else:
            _print_summary(run)

        return 0 if run.error is None else 1
    finally:
        ui.set_quiet(False)
