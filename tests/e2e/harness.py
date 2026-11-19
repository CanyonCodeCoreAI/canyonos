# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Recorded calls for the E2E check: every CLI command, HTTP request and
Docker command a case makes goes through here, so a failure can show what went
in and what came out without the case doing anything extra."""

from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json as _json
import os
import pty
import re
import secrets
import select
import shutil
import signal
import ssl
import struct
import subprocess
import tempfile
import termios
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode

import redis
import requests
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
API_URL = "http://127.0.0.1:3000"
DASHBOARD_WEB = "canyonos-dashboard-web"
OUTPUT_LIMIT = 20_000
KILL_GRACE = 10
TERMINAL_SIZE = (40, 120)
ESCAPE_SEQUENCE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
API_KEY_ENV = "CANYONOS_API_KEY"


@dataclass
class Call:
    """One recorded command or request: what was sent, what came back (for a request,
    its headers too, by lowercase name), how it ended."""

    kind: str
    label: str
    input: str
    output: str
    code: int
    seconds: float
    stdout: str = ""
    headers: dict[str, str] = field(default_factory=dict)

    def json(self):
        """The output parsed as JSON: an HTTP body, or a command's stdout."""
        return _json.loads(self.stdout if self.kind != "http" else self.output)

    def as_dict(self) -> dict:
        """The call as a plain dict, ready for a JSON line, with a long output
        clipped to its head and tail."""
        return {
            **asdict(self),
            "output": _clip(self.output),
            "stdout": _clip(self.stdout),
        }


class CallFailed(AssertionError):
    """A checked call ended with a non-zero exit code or an HTTP error status."""

    def __init__(self, call: Call):
        super().__init__(f"{call.label} -> {call.code}\n{call.output[-2000:]}")
        self.call = call


def _new_api_key() -> str:
    return f"e2e-{secrets.token_urlsafe(32)}"


@dataclass
class Recorder:
    """The calls made so far in this session, in order, every workflow group folder
    `stage` made, each with the number of calls made before it, and the session's
    own API key, which every `canyonos` it runs gets as CANYONOS_API_KEY, so a run
    never uses the caller's `~/.canyonos/api_key` nor writes its key there."""

    calls: list[Call] = field(default_factory=list)
    staged: list[tuple[int, Path]] = field(default_factory=list)
    api_key: str = field(default_factory=_new_api_key)

    def record(self, call: Call) -> Call:
        self.calls.append(call)
        return call

    def staged_since(self, start: int) -> list[Path]:
        """The workflow group folders staged once `start` calls had been made."""
        return [path for index, path in self.staged if index >= start]

    def dump(self, path: Path, start: int = 0) -> None:
        """Write the calls from index `start` on as JSON lines to `path`."""
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w") as handle:
            for call in self.calls[start:]:
                handle.write(_json.dumps(call.as_dict()) + "\n")


def _clip(text: str) -> str:
    if len(text) <= OUTPUT_LIMIT:
        return text
    half = OUTPUT_LIMIT // 2
    cut = len(text) - OUTPUT_LIMIT
    return f"{text[:half]}\n...[{cut} characters cut]...\n{text[-half:]}"


IMAGES = {
    "CANYONOS_CORE_IMAGE": [
        "-f",
        "packages/core/Dockerfile",
        "-t",
        "canyonos-core:dev",
        "packages/core",
    ],
    "CANYONOS_API_IMAGE": [
        "-f",
        "packages/api/Dockerfile",
        "-t",
        "canyonos-api:dev",
        ".",
    ],
    "CANYONOS_WEB_IMAGE": [
        "-f",
        "packages/web/Dockerfile",
        "--target",
        "canyonos",
        "--build-arg",
        "VITE_API_URL=/api",
        "-t",
        "canyonos-web:dev",
        ".",
    ],
}


def cli_env(api_key: str | None = None) -> dict[str, str]:
    """The environment every `canyonos` command runs with: the images built from
    this checkout instead of the published ones, no usage API, so a run never
    sends usage events, and `api_key` as CANYONOS_API_KEY, or no CANYONOS_API_KEY at
    all when it is None. An image CI already built and named in its
    CANYONOS_*_IMAGE variable is kept; any other is `local`, the `:dev` tag
    `build_images` makes.

    HOME stays the caller's: the CLI keeps its state, the dashboard's settings and
    the usage outbox under `~/.canyonos` with no other setting for it, and a
    different HOME would also hide Docker's own config and uv's cache. The API key is
    the exception: CANYONOS_API_KEY wins over `~/.canyonos/api_key` and is never
    written to it."""
    environment = {
        **os.environ,
        "CANYONOS_ENV": "development",
        "CANYONOS_USAGE_URL": "off",
        **{name: os.environ.get(name) or "local" for name in IMAGES},
    }
    environment.pop(API_KEY_ENV, None)
    if api_key is not None:
        environment[API_KEY_ENV] = api_key
    return environment


def build_images(recorder: "Recorder") -> None:
    """Build the `:dev` image for every CANYONOS_*_IMAGE that CI did not provide."""
    for name, args in IMAGES.items():
        if os.environ.get(name, "local") == "local":
            docker(recorder, ["build", "--progress=plain", *args], timeout=1800)


def run(
    recorder: Recorder,
    argv: list[str],
    *,
    cwd,
    env: dict[str, str] | None = None,
    stdin: str | None = None,
    timeout: int = 600,
    check: bool = True,
    kind: str = "cli",
) -> Call:
    """Run a command to completion with its output captured and recorded. With
    `check`, a non-zero exit raises CallFailed carrying the call. The command runs
    in its own process group, so a timeout stops it and everything it started,
    not only `uv`, and records exit code -1."""
    started = time.monotonic()
    process = subprocess.Popen(
        argv,
        cwd=str(cwd),
        env=env,
        stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(stdin, timeout=timeout)
        output, code = stdout + stderr, process.returncode
    except subprocess.TimeoutExpired:
        stdout, stderr = _stop_group(process)
        output = f"{stdout}{stderr}\n[timed out after {timeout}s]"
        code = -1
    call = recorder.record(
        Call(
            kind=kind,
            label=" ".join(argv),
            input=stdin or "",
            output=output,
            code=code,
            seconds=round(time.monotonic() - started, 2),
            stdout=stdout,
        )
    )
    if check and code != 0:
        raise CallFailed(call)
    return call


def run_in_terminal(
    recorder: Recorder,
    argv: list[str],
    *,
    cwd,
    answers: list[tuple[str, str]],
    env: dict[str, str] | None = None,
    timeout: int = 600,
    check: bool = True,
) -> Call:
    """Run a command to completion in a terminal, as someone at the keyboard would:
    `answers` are (prompt, keys) pairs, and each time the command's output shows the
    next prompt, its keys are typed. The output is recorded without its escape
    sequences. A timeout stops the command's process group, as in `run`."""
    controller, terminal = pty.openpty()
    fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", *TERMINAL_SIZE, 0, 0))
    started = time.monotonic()
    process = subprocess.Popen(
        argv,
        cwd=str(cwd),
        env=env,
        stdin=terminal,
        stdout=terminal,
        stderr=terminal,
        start_new_session=True,
    )
    os.close(terminal)
    pending, written, unread = list(answers), [], 0
    output, code = "", None
    while code is None:
        if time.monotonic() - started > timeout:
            _stop_group(process)
            output += f"\n[timed out after {timeout}s]"
            code = -1
            break
        if not select.select([controller], [], [], 1)[0]:
            code = process.poll()
            continue
        try:
            chunk = os.read(controller, 4096).decode(errors="replace")
        except OSError:
            chunk = ""
        if not chunk:
            code = process.wait()
            break
        output += chunk
        shown = ESCAPE_SEQUENCE.sub("", output)
        while pending and pending[0][0] in shown[unread:]:
            prompt, keys = pending.pop(0)
            unread = shown.index(prompt, unread) + len(prompt)
            os.write(controller, keys.encode())
            written.append(keys)
    os.close(controller)
    unanswered = [prompt for prompt, _ in pending]
    call = recorder.record(
        Call(
            kind="cli",
            label=" ".join(argv),
            input=repr(written),
            output=ESCAPE_SEQUENCE.sub("", output)
            + (f"\n[never prompted: {unanswered}]" if unanswered else ""),
            code=code,
            seconds=round(time.monotonic() - started, 2),
        )
    )
    if check and (code != 0 or unanswered):
        raise CallFailed(call)
    return call


def _signal_group(process: subprocess.Popen, sig: signal.Signals) -> None:
    with contextlib.suppress(PermissionError, ProcessLookupError):
        os.killpg(process.pid, sig)


def _stop_group(process: subprocess.Popen) -> tuple[str, str]:
    """Stop the process group `run` started, SIGTERM then SIGKILL after KILL_GRACE
    seconds, and return what it wrote; empty when a process outside the group still
    holds its output open."""
    _signal_group(process, signal.SIGTERM)
    try:
        process.wait(timeout=KILL_GRACE)
    except subprocess.TimeoutExpired:
        pass
    _signal_group(process, signal.SIGKILL)
    try:
        stdout, stderr = process.communicate(timeout=KILL_GRACE)
    except subprocess.TimeoutExpired:
        process.kill()
        return "", "[output lost: a process outside the group kept it open]"
    return stdout or "", stderr or ""


def canyonos(
    recorder: Recorder,
    args: list[str],
    *,
    cwd,
    timeout: int = 600,
    check: bool = True,
    keyed: bool = True,
) -> Call:
    """Run the checkout's `canyonos` command in the folder `cwd`, with the session's
    API key unless `keyed` is False."""
    argv = ["uv", "run", "--project", str(REPO_ROOT), "--frozen", "canyonos", *args]
    env = cli_env(recorder.api_key if keyed else None)
    return run(recorder, argv, cwd=cwd, env=env, timeout=timeout, check=check)


def canyonos_in_terminal(
    recorder: Recorder,
    args: list[str],
    *,
    cwd,
    answers: list[tuple[str, str]],
    timeout: int = 600,
    check: bool = True,
) -> Call:
    """Run the checkout's `canyonos` command in a terminal from `cwd`, typing each of
    `answers` when its prompt shows (see `run_in_terminal`), with the session's API
    key."""
    argv = ["uv", "run", "--project", str(REPO_ROOT), "--frozen", "canyonos", *args]
    return run_in_terminal(
        recorder,
        argv,
        cwd=cwd,
        answers=answers,
        env=cli_env(recorder.api_key),
        timeout=timeout,
        check=check,
    )


def docker(
    recorder: Recorder, args: list[str], *, timeout: int = 600, check: bool = True
) -> Call:
    """Run a `docker` command from the repository root."""
    return run(
        recorder,
        ["docker", *args],
        cwd=REPO_ROOT,
        timeout=timeout,
        check=check,
        kind="docker",
    )


def http(
    recorder: Recorder,
    method: str,
    url: str,
    *,
    json=None,
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: int = 30,
    check: bool = True,
) -> Call:
    """Send one HTTP request, with a JSON body or the raw bytes `data`, and record its
    body and status. With `check`, a status of 400 or more raises CallFailed carrying
    the call."""
    started = time.monotonic()
    body = (
        f"<{len(data)} bytes>"
        if data is not None
        else ""
        if json is None
        else _json.dumps(json)
    )
    try:
        response = requests.request(
            method, url, json=json, data=data, headers=headers, timeout=timeout
        )
        output, code = response.text, response.status_code
        received = {name.lower(): value for name, value in response.headers.items()}
    except requests.RequestException as error:
        output, code = f"{type(error).__name__}: {error}", -1
        received = {}
    call = recorder.record(
        Call(
            kind="http",
            label=f"{method.upper()} {url}",
            input=body,
            output=output,
            code=code,
            seconds=round(time.monotonic() - started, 2),
            headers=received,
        )
    )
    if check and (code < 0 or code >= 400):
        raise CallFailed(call)
    return call


def poll(predicate, *, timeout: float, interval: float = 5, what: str):
    """Call `predicate` until it returns something truthy and return that; raise
    AssertionError naming `what` when `timeout` seconds pass first."""
    deadline = time.monotonic() + timeout
    while True:
        value = predicate()
        if value:
            return value
        if time.monotonic() >= deadline:
            raise AssertionError(f"timed out after {timeout}s waiting for {what}")
        time.sleep(interval)


class Api:
    """The dashboard API, sent `api_key` on every request; with no key, when the API
    needs none, nothing is sent."""

    def __init__(self, recorder: Recorder, base_url: str, api_key: str | None):
        self.recorder = recorder
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    @property
    def headers(self) -> dict[str, str]:
        """The header that sends the key, if there is one."""
        return bearer(self.api_key) if self.api_key is not None else {}

    def request(self, method: str, path: str, *, json=None, check: bool = True) -> Call:
        return http(
            self.recorder,
            method,
            f"{self.base_url}{path}",
            json=json,
            headers=self.headers,
            check=check,
        )

    def get(self, path: str, **kwargs) -> Call:
        return self.request("GET", path, **kwargs)

    def post(self, path: str, **kwargs) -> Call:
        return self.request("POST", path, **kwargs)

    def put(self, path: str, **kwargs) -> Call:
        return self.request("PUT", path, **kwargs)

    def delete(self, path: str, **kwargs) -> Call:
        return self.request("DELETE", path, **kwargs)


def traces(api: Api, workflow_id: str) -> list[dict]:
    """The workflow's traces from the last hour, as the dashboard API lists them."""
    now = datetime.now(timezone.utc)
    window = urlencode(
        {
            "from": (now - timedelta(hours=1)).isoformat(),
            "to": (now + timedelta(minutes=5)).isoformat(),
        }
    )
    path = f"/workflows/{workflow_id}/monitoring/traces?{window}"
    return api.get(path).json()["traces"]


def dashboard_key(recorder: Recorder) -> str | None:
    """The session's API key when the dashboard API reports it needs one
    (`/auth/status`); None when it needs none, since every route then answers
    without one."""
    status = http(recorder, "GET", f"{API_URL}/auth/status").json()
    return recorder.api_key if status["api_key_required"] else None


def case_slug(module: str, name: str) -> str:
    """The directory name a case's trace goes under, safe for any filesystem."""
    return re.sub(r"[^A-Za-z0-9_-]", "_", f"{module}__{name}")


def collect_container_logs(
    recorder: Recorder, directory: Path, tail: int = 200
) -> None:
    """Write the last `tail` lines of every container whose name has `canyonos`,
    running or not, into `directory`, one file per container."""
    directory.mkdir(parents=True, exist_ok=True)
    names = docker(
        recorder, ["ps", "-a", "--filter", "name=canyonos", "--format", "{{.Names}}"]
    ).output.split()
    for name in sorted(names):
        call = docker(recorder, ["logs", "--tail", str(tail), name], check=False)
        (directory / f"{name}.log").write_text(call.output)


def workflow_root(workspace: Path) -> Path:
    """The folder `canyonos` reads the workflow in the workflow folder `workspace`
    from: `.canyon` when there is one, else the workflow folder itself, the rule the
    CLI follows."""
    canyon = workspace / ".canyon"
    return canyon if canyon.is_dir() else workspace


def workflow_dir(deployment: Path) -> Path:
    """The workflow folder `stage` put in the workflow group folder `deployment`: the
    folder of the same name inside it, so the workflow and the dashboard share it."""
    return deployment / deployment.name


def workflow_name(workspace: Path, deployment: Path | None = None) -> str:
    """The name the workflow group in `deployment`, by default the folder holding
    `workspace`, gives the workflow folder `workspace`: its `workflows:` entry's, its
    folder's name and the start of its workflow_id, which the deploy writes."""
    deployment = deployment or workspace.parent
    config = yaml.safe_load((deployment / "workflow_group.yaml").read_text())
    for name, entry in (config.get("workflows") or {}).items():
        if (deployment / entry["path"]).resolve() == workspace.resolve():
            return name
    raise AssertionError(
        f"{deployment}/workflow_group.yaml has no workflow for {workspace}"
    )


def qualified(workspace: Path, name: str) -> str:
    """`name`, an agent or `<agent>.<method>` of the workflow in the workflow folder
    `workspace`, as the workflow group names it: `<workflow>.<name>`."""
    return f"{workflow_name(workspace)}.{name}"


def docker_name(agent: str) -> str:
    """An agent's name, `<workflow>.<agent>`, as its containers and image name it:
    lowercase, with the `.` written `--`."""
    return agent.lower().replace(".", "--")


def stage(recorder: Recorder, workflow, parent: Path, secrets: dict[str, str]) -> Path:
    """Copy `workflow` into `parent/<name>/<name>` and return `parent/<name>`, the
    workflow group folder to run `canyonos` from, named as the dashboard names the
    workflow group, and note it on `recorder` for the traces. In order: its source from
    this repo, without any `.car`, `.canyon` or `.env` at any depth, or cloned whole
    at its pinned commit, with the `workflow_group.yaml` of the workflow group folder a
    source from this repo sits in; then its committed port as `.canyon`; then its
    overlay files; then its `workflow_group.yaml`, if any, moved up into the workflow group
    folder; then the workflow's `env` and `secrets` added to the workflow folder's
    `.env`."""
    from .workflows import Git

    deployment = parent / workflow.name
    staged = workflow_dir(deployment)
    recorder.staged.append((len(recorder.calls), deployment))
    if isinstance(workflow.source, Git):
        clone = parent / f"{workflow.name}-clone"
        git = ["git", "-c", "advice.detachedHead=false"]
        env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
        url = workflow.source.clone_url
        argv = [*git, "clone", "--filter=blob:none", "--no-checkout", url, str(clone)]
        run(recorder, argv, cwd=parent, env=env)
        sparse = [*git, "sparse-checkout", "set", workflow.source.path]
        run(recorder, sparse, cwd=clone, env=env)
        run(recorder, [*git, "checkout", workflow.source.ref], cwd=clone, env=env)
        shutil.copytree(clone / workflow.source.path, staged, symlinks=True)
    else:
        shutil.copytree(workflow.source, staged, symlinks=True, ignore=_stale)
        if (workflow.source.parent / "workflow_group.yaml").is_file():
            shutil.copy(workflow.source.parent / "workflow_group.yaml", deployment)
    if workflow.port is not None:
        shutil.copytree(workflow.port, staged / ".canyon", dirs_exist_ok=True)
    for target, file in workflow.overlay.items():
        shutil.copy(file, staged / target)
    if (staged / "workflow_group.yaml").is_file():
        (staged / "workflow_group.yaml").rename(deployment / "workflow_group.yaml")
    _write_env(staged / ".env", {**workflow.env, **secrets})
    return deployment


def _stale(directory, names):
    """Skip what a local checkout of an example may hold but the repo does not, in
    every folder: an old `.car` port, a previous deploy's `.canyon` and a
    developer's `.env`. The committed port is copied after this, so it stays."""
    return [name for name in names if name in (".car", ".canyon", ".env")]


def _write_env(path: Path, values: dict[str, str]) -> None:
    """Keep the `.env` lines the staged workflow already has (a cloned source's or
    an overlay's; a repo source's was skipped), drop any line for a key set here,
    then append the values."""
    kept = []
    if path.is_file():
        for line in path.read_text().splitlines():
            key = line.split("=", 1)[0].lstrip("#").strip()
            if key not in values:
                kept.append(line)
    lines = [*kept, "", *(f"{key}={value}" for key, value in values.items()), ""]
    path.write_text("\n".join(lines))


def query_for(workflow, workspace: Path):
    """The query the workflow is checked with: workflow.yaml's `query`, else the
    port's `config/test_query.txt`."""
    if workflow.query is not None:
        return workflow.query
    return (workflow_root(workspace) / "config" / "test_query.txt").read_text().strip()


def as_argument(endpoint: Endpoint, query) -> str:
    """The query as `canyonos test` takes it on the command line. The CLI sends the
    text as every argument, so a query that is not a string goes as the JSON request
    body, `{"<first argument>": query}`, which the workflow reads back from the
    text."""
    if isinstance(query, str):
        return query
    return _json.dumps({endpoint.argument: query})


def manifest(workspace: Path) -> dict:
    """The workflow's parsed `config/workflow_config.yaml`."""
    path = workflow_root(workspace) / "config" / "workflow_config.yaml"
    return yaml.safe_load(path.read_text())


def bearer(api_key: str) -> dict[str, str]:
    """The header that sends `api_key`."""
    return {"Authorization": f"Bearer {api_key}"}


def hash_api_key(api_key: str) -> str:
    """The SHA-256 of `api_key` in lowercase hex, the only form of the key a
    verifier holds."""
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Endpoint:
    """The deployed endpoint: its base URL, its first route
    (`<workflow>/<agent>/<method>`), the agent that route calls (`<workflow>.<agent>`),
    the name of that method's first argument (the one a query goes in), the API key
    it is called with (None for a deploy without one) and the names of all its
    arguments."""

    url: str
    route: str
    agent: str
    argument: str
    api_key: str | None
    arguments: tuple[str, ...] = ()

    @property
    def headers(self) -> dict[str, str]:
        """The header every request to the endpoint sends its key in, if any."""
        return bearer(self.api_key) if self.api_key is not None else {}


def cli_python(recorder: Recorder, workspace: Path, script: str) -> Call:
    """Run `script` with the checkout's CLI modules from the workflow group folder, the
    way the CLI itself would see the workflow group. Python runs isolated (`-I`), so a workflow
    file such as `json.py` never shadows a module the script imports."""
    argv = [
        "uv",
        "run",
        "--project",
        str(REPO_ROOT),
        "--frozen",
        "python",
        "-I",
        "-c",
        script,
    ]
    return run(recorder, argv, cwd=workspace, env=cli_env(recorder.api_key))


def cli_value(recorder: Recorder, workspace: Path, expression: str, imports: str):
    """Evaluate `expression` with `cli_python` and return it parsed from JSON."""
    script = f"import json; {imports}; print(json.dumps({expression}))"
    output = cli_python(recorder, workspace, script).stdout
    return _json.loads(output.strip().splitlines()[-1])


def deployment_group(recorder: Recorder, workspace: Path) -> str:
    """The Docker group of the workflow group in `workspace`, `canyonos-<folder>-`
    and the start of its deployment_id, which every container name starts with."""
    return cli_value(
        recorder,
        workspace,
        "deployment_group()",
        "from canyonos.deployment import deployment_group",
    )


def stop_workflow_group(
    recorder: Recorder, workspace: Path, *, timeout: int = 600
) -> Call | None:
    """`canyonos stop <name>` for the workflow group in `workspace`, named so the
    stop never has to ask which workflow group when others run too. None when the
    folder has no deploy record, so there is nothing to stop."""
    name = cli_value(
        recorder,
        workspace,
        "deployment_name() if os.path.isfile(state_path()) else None",
        "import os; from canyonos.deployment import deployment_name, state_path",
    )
    if name is None:
        return None
    return canyonos(
        recorder, ["stop", name], cwd=workspace, timeout=timeout, check=False
    )


def deployed_workflow_id(api: Api, workspace: Path) -> str:
    """The dashboard id of the workflow in the workflow group folder `workspace`: the
    `workflow_id` `canyonos deploy` saved for it in `workflow_group.yaml`, which the
    dashboard registers it under. Fail unless the dashboard lists it by its name."""
    name = workflow_name(workflow_dir(workspace))
    config = yaml.safe_load((workspace / "workflow_group.yaml").read_text())
    workflow_id = config["workflows"][name]["workflow_id"]
    workflows = api.get("/workflows").json()
    names = {workflow["id"]: workflow["name"] for workflow in workflows}
    assert names.get(workflow_id) == name, (
        f"the dashboard does not list {workflow_id} as {name}: {workflows}"
    )
    return workflow_id


def redis_port(recorder: Recorder, workspace: Path) -> int:
    """The host port of the deployed workflow group's Redis, as the CLI recorded it."""
    return cli_value(
        recorder,
        workspace,
        "load_state()['redis_port']",
        "from canyonos.init import load_state",
    )


def controller_headers(recorder: Recorder, workspace: Path) -> dict[str, str]:
    """The headers the CLI sends the workflow group's Global Controller, with the secret
    its state.json holds."""
    return cli_value(
        recorder,
        workspace,
        "load_state()['headers']",
        "from canyonos.init import load_state",
    )


def redis_client_files(recorder: Recorder, workspace: Path) -> dict[str, str] | None:
    """A client certificate the workflow group's CA signs, written to a private temp folder:
    `{ca, cert, key}` file paths, or None when its Redis takes plaintext."""
    pems = cli_value(
        recorder,
        workspace,
        "client_certificate('e2e')",
        "from canyonos.internal_ca import client_certificate",
    )
    if pems is None:
        return None
    folder = Path(tempfile.mkdtemp(prefix="canyonos-e2e-tls-"))
    files = {}
    for name, pem in pems.items():
        path = folder / f"{name}.pem"
        path.write_text(pem)
        path.chmod(0o600)
        files[name] = str(path)
    return files


def redis_tls_context(recorder: Recorder, workspace: Path) -> ssl.SSLContext | None:
    """The TLS context a host process reaches the workflow group's Redis with, presenting the
    client certificate its CA signs; None when its Redis takes plaintext."""
    files = redis_client_files(recorder, workspace)
    if files is None:
        return None
    context = ssl.create_default_context(cafile=files["ca"])
    context.load_cert_chain(files["cert"], files["key"])
    return context


def redis_password(recorder: Recorder, workspace: Path) -> str:
    """The password the deployed workflow group's Redis container was started with."""
    container = f"{deployment_group(recorder, workspace)}-redis-localhost"
    env = docker(recorder, ["inspect", "-f", "{{json .Config.Env}}", container]).json()
    return dict(entry.split("=", 1) for entry in env)["CANYONOS_REDIS_PASSWORD"]


def workflow_group_redis(recorder: Recorder, workspace: Path) -> redis.Redis:
    """The deployed workflow group's Redis, on the host port the CLI recorded for it, signed in
    with its container's password, over TLS with a client certificate its CA signs when
    its Redis takes only that."""
    files = redis_client_files(recorder, workspace)
    tls = (
        {
            "ssl": True,
            "ssl_ca_certs": files["ca"],
            "ssl_certfile": files["cert"],
            "ssl_keyfile": files["key"],
        }
        if files
        else {}
    )
    return redis.Redis(
        host="127.0.0.1",
        port=redis_port(recorder, workspace),
        password=redis_password(recorder, workspace),
        decode_responses=True,
        **tls,
    )


def deployed_endpoint(
    recorder: Recorder, workspace: Path, *, keyed: bool = True
) -> Endpoint:
    """Ask the running Global Controller for the endpoint, from the workflow group folder,
    called with the session's API key unless `keyed` is False."""
    endpoint = cli_value(
        recorder,
        workspace,
        "deploy_status(load_state())['endpoint']",
        "from canyonos.gc import deploy_status; from canyonos.init import load_state",
    )
    route = endpoint["routes"][0]
    return Endpoint(
        url=f"http://127.0.0.1:{endpoint['api_port']}",
        route=route["workflow_id"],
        agent=f"{route['workflow']}.{route['agent']}",
        argument=route["arguments"][0],
        api_key=recorder.api_key if keyed else None,
        arguments=tuple(route["arguments"]),
    )


def submit(recorder: Recorder, endpoint: Endpoint, query) -> str:
    """POST `query` to the endpoint as its first argument and return its request
    id; fail unless the endpoint answers 202, its answer for a queued request."""
    url = f"{endpoint.url}/{endpoint.route}"
    call = http(
        recorder,
        "POST",
        url,
        json={endpoint.argument: query},
        headers=endpoint.headers,
    )
    assert call.code == 202, call.output
    return call.json()["request_id"]


def answer(
    recorder: Recorder,
    endpoint: Endpoint,
    request_id: str,
    body: dict,
    *,
    check: bool = True,
) -> Call:
    """POST `body` to `/answer/<request_id>`, answering the request's oldest
    waiting question."""
    url = f"{endpoint.url}/answer/{request_id}"
    return http(recorder, "POST", url, json=body, headers=endpoint.headers, check=check)


def finished(recorder: Recorder, endpoint: Endpoint, request_id: str, *, timeout):
    """Poll `/status/<request_id>` until it is done or failed and return the status
    body. An unanswered request or a 5xx is retried, since the endpoint may be
    busy; a 4xx fails the call at once. Raise AssertionError with the last answer
    when `timeout` seconds pass first."""
    url = f"{endpoint.url}/status/{request_id}"
    answers: list[Call] = []

    def settled():
        call = http(recorder, "GET", url, headers=endpoint.headers, check=False)
        answers.append(call)
        if call.code < 0 or call.code >= 500:
            return None
        if call.code >= 400:
            raise CallFailed(call)
        status = call.json()
        return status if status["status"] in ("done", "error") else None

    try:
        return poll(settled, timeout=timeout, interval=2, what=f"request {request_id}")
    except AssertionError as error:
        if isinstance(error, CallFailed) or not answers:
            raise
        last = answers[-1]
        raise AssertionError(
            f"{error}; last answer {last.code}: {last.output[-500:]}"
        ) from None


def result_of(recorder: Recorder, endpoint: Endpoint, query, *, timeout):
    """Send `query`, wait for it, and return its request id and result; a workflow
    error fails the call."""
    request_id = submit(recorder, endpoint, query)
    status = finished(recorder, endpoint, request_id, timeout=timeout)
    if status["status"] == "error":
        raise AssertionError(f"workflow error: {status.get('error')}")
    return request_id, status["result"]


def greets(recorder: Recorder, workspace: Path, name: str) -> None:
    """Send `name` to the endpoint deployed from `workspace` and fail unless
    helloworld's HelloAgent greets it."""
    endpoint = deployed_endpoint(recorder, workspace)
    _, result = result_of(recorder, endpoint, name, timeout=60)
    assert result == {"greeting": f"Hello, {name}! I'm the HelloAgent!"}, result


def workflow_group_containers(
    recorder: Recorder, group: str, *, every=False
) -> dict[str, str]:
    """The containers in the Docker group `group` by name, each with its state;
    stopped ones too when `every` is set."""
    label = f"label=com.docker.compose.project={group}"
    args = ["ps", *(["-a"] if every else []), "--filter", label]
    listing = docker(recorder, [*args, "--format", "{{.Names}}\t{{.State}}"]).output
    return dict(line.split("\t") for line in listing.splitlines() if "\t" in line)


def dashboard_containers(recorder: Recorder, *, every=False) -> list[str]:
    """The running containers of the shared dashboard, the `canyonos-dashboard`
    compose project, sorted; stopped ones too when `every` is set."""
    label = "label=com.docker.compose.project=canyonos-dashboard"
    args = ["ps", *(["-a"] if every else []), "--filter", label]
    return sorted(docker(recorder, [*args, "--format", "{{.Names}}"]).output.split())


def dashboard_port(recorder: Recorder) -> int:
    """The host port the running dashboard's web container is published on."""
    published = docker(recorder, ["port", DASHBOARD_WEB, "8080/tcp"]).output
    return int(published.split()[0].rsplit(":", 1)[1])
