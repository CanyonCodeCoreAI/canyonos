# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Recorded calls for the E2E check: every CLI command, HTTP request and
Docker command a case makes goes through here, so a failure can show what went
in and what came out without the case doing anything extra."""

from __future__ import annotations

import contextlib
import json as _json
import os
import re
import shutil
import signal
import subprocess
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

import requests
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
API_URL = "http://127.0.0.1:3000"
OUTPUT_LIMIT = 20_000
KILL_GRACE = 10
AUTH_MODES = ("none", "password")
SIGN_IN_EMAIL = "e2e@canyonos.test"
SIGN_IN_PASSWORD = "e2e-password-1"


@dataclass
class Call:
    """One recorded command or request: what was sent, what came back, how it ended."""

    kind: str
    label: str
    input: str
    output: str
    code: int
    seconds: float
    stdout: str = ""

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


@dataclass
class Recorder:
    """The calls made so far in this session, in order, and every project folder
    `stage` made, each with the number of calls made before it."""

    calls: list[Call] = field(default_factory=list)
    staged: list[tuple[int, Path]] = field(default_factory=list)

    def record(self, call: Call) -> Call:
        self.calls.append(call)
        return call

    def staged_since(self, start: int) -> list[Path]:
        """The project folders staged once `start` calls had been made."""
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


def cli_env() -> dict[str, str]:
    """The environment every `canyonos` command runs with: the images built from
    this checkout instead of the published ones, and no usage API, so a run never
    sends usage events. An image CI already built and named in its CANYONOS_*_IMAGE
    variable is kept; any other is `local`, the `:dev` tag `build_images` makes.

    HOME stays the caller's: the CLI keeps its state, the dashboard's settings and
    the usage outbox under `~/.canyonos` with no other setting for it, and a
    different HOME would also hide Docker's own config and uv's cache."""
    return {
        **os.environ,
        "CANYONOS_ENV": "development",
        "CANYONOS_USAGE_URL": "off",
        **{name: os.environ.get(name) or "local" for name in IMAGES},
    }


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
    recorder: Recorder, args: list[str], *, cwd, timeout: int = 600, check: bool = True
) -> Call:
    """Run the checkout's `canyonos` command in the project directory `cwd`."""
    argv = ["uv", "run", "--project", str(REPO_ROOT), "--frozen", "canyonos", *args]
    return run(recorder, argv, cwd=cwd, env=cli_env(), timeout=timeout, check=check)


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
    headers: dict[str, str] | None = None,
    timeout: int = 30,
    check: bool = True,
) -> Call:
    """Send one HTTP request and record its body and status. With `check`, a status
    of 400 or more raises CallFailed carrying the call."""
    started = time.monotonic()
    body = "" if json is None else _json.dumps(json)
    try:
        response = requests.request(
            method, url, json=json, headers=headers, timeout=timeout
        )
        output, code = response.text, response.status_code
    except requests.RequestException as error:
        output, code = f"{type(error).__name__}: {error}", -1
    call = recorder.record(
        Call(
            kind="http",
            label=f"{method.upper()} {url}",
            input=body,
            output=output,
            code=code,
            seconds=round(time.monotonic() - started, 2),
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
    """The dashboard API as one signed-in user, or as anyone when sign-in is off
    and there is no token to send."""

    def __init__(self, recorder: Recorder, base_url: str, token: str | None):
        self.recorder = recorder
        self.base_url = base_url.rstrip("/")
        self.headers = {} if token is None else {"Authorization": f"Bearer {token}"}

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


def sign_in(recorder: Recorder, base_url: str) -> str | None:
    """Register the E2E account, or log in once registration is closed, and
    return the bearer token. Return None when the API runs with sign-in off
    (`AUTH_MODE=none`, what the CLI's dashboard runs with), since every route then
    answers without a token. Any other mode fails the call."""
    mode = http(recorder, "GET", f"{base_url}/auth/status").json()["mode"]
    if mode not in AUTH_MODES:
        raise AssertionError(f"the dashboard API reports an unknown auth mode {mode!r}")
    if mode == "none":
        return None
    credentials = {"email": SIGN_IN_EMAIL, "password": SIGN_IN_PASSWORD}
    call = http(
        recorder,
        "POST",
        f"{base_url}/auth/register",
        json={**credentials, "password_confirmation": SIGN_IN_PASSWORD},
        check=False,
    )
    if call.code == 403:
        call = http(recorder, "POST", f"{base_url}/auth/login", json=credentials)
    elif call.code != 201:
        raise CallFailed(call)
    return call.json()["token"]


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


def project_root(workspace: Path) -> Path:
    """The folder `canyonos` reads the project from: `.canyon` when there is one,
    else the project folder itself, the rule the CLI follows."""
    canyon = workspace / ".canyon"
    return canyon if canyon.is_dir() else workspace


def stage(recorder: Recorder, project, parent: Path, secrets: dict[str, str]) -> Path:
    """Copy `project` into `parent/<name>`, the folder name the dashboard names it
    after, and note it on `recorder` for the traces. In order: its source from this
    repo, without any `.car`, `.canyon` or `.env` at any depth, or cloned whole at
    its pinned commit; then its committed port as `.canyon`; then its overlay
    files; then the project's `env` and `secrets` added to the top-level `.env`."""
    from .projects import Git

    staged = parent / project.name
    recorder.staged.append((len(recorder.calls), staged))
    if isinstance(project.source, Git):
        clone = parent / f"{project.name}-clone"
        git = ["git", "-c", "advice.detachedHead=false"]
        env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
        url = project.source.clone_url
        argv = [*git, "clone", "--filter=blob:none", "--no-checkout", url, str(clone)]
        run(recorder, argv, cwd=parent, env=env)
        sparse = [*git, "sparse-checkout", "set", project.source.path]
        run(recorder, sparse, cwd=clone, env=env)
        run(recorder, [*git, "checkout", project.source.ref], cwd=clone, env=env)
        shutil.copytree(clone / project.source.path, staged, symlinks=True)
    else:
        shutil.copytree(project.source, staged, symlinks=True, ignore=_stale)
    if project.port is not None:
        shutil.copytree(project.port, staged / ".canyon", dirs_exist_ok=True)
    for target, file in project.overlay.items():
        shutil.copy(file, staged / target)
    _write_env(staged / ".env", {**project.env, **secrets})
    return staged


def _stale(directory, names):
    """Skip what a local checkout of an example may hold but the repo does not, in
    every folder: an old `.car` port, a previous deploy's `.canyon` and a
    developer's `.env`. The committed port is copied after this, so it stays."""
    return [name for name in names if name in (".car", ".canyon", ".env")]


def _write_env(path: Path, values: dict[str, str]) -> None:
    """Keep the `.env` lines the staged project already has (a cloned source's or
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


def query_for(project, workspace: Path):
    """The query the project is checked with: project.yaml's `query`, else the
    port's `config/test_query.txt`."""
    if project.query is not None:
        return project.query
    return (project_root(workspace) / "config" / "test_query.txt").read_text().strip()


def as_argument(endpoint: Endpoint, query) -> str:
    """The query as `canyonos test` takes it on the command line. The CLI sends the
    text as every argument, so a query that is not a string goes as the JSON request
    body, `{"<first argument>": query}`, which the workflow reads back from the
    text."""
    if isinstance(query, str):
        return query
    return _json.dumps({endpoint.argument: query})


def manifest(workspace: Path) -> dict:
    """The project's parsed `config/global_controller.yaml`."""
    path = project_root(workspace) / "config" / "global_controller.yaml"
    return yaml.safe_load(path.read_text())


@dataclass(frozen=True)
class Endpoint:
    """The deployed endpoint: its base URL, its route, the name of its first
    argument (the one a query goes in) and the names of all its arguments."""

    url: str
    route: str
    argument: str
    arguments: tuple[str, ...] = ()


def cli_python(recorder: Recorder, workspace: Path, script: str) -> Call:
    """Run `script` with the checkout's CLI modules from the project folder, the way
    the CLI itself would see the project. Python runs isolated (`-I`), so a project
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
    return run(recorder, argv, cwd=workspace, env=cli_env())


def cli_value(recorder: Recorder, workspace: Path, expression: str, imports: str):
    """Evaluate `expression` with `cli_python` and return it parsed from JSON."""
    script = f"import json; {imports}; print(json.dumps({expression}))"
    output = cli_python(recorder, workspace, script).stdout
    return _json.loads(output.strip().splitlines()[-1])


def project_group(recorder: Recorder, workspace: Path) -> str:
    """The Docker group of the deployed project in `workspace`, `canyonos-<folder>-`
    and the start of its project_id, which every container name starts with."""
    return cli_value(
        recorder,
        workspace,
        "project_group()",
        "from canyonos.project import project_group",
    )


def deployed_project_id(
    recorder: Recorder, api: Api, workspace: Path, name: str
) -> str:
    """The dashboard id of the project deployed from `workspace`: the `project_id`
    `canyonos deploy` saved in its `global_controller.yaml`, which the dashboard
    registers it under. Fail unless the dashboard lists that id as `name`."""
    project_id = cli_value(
        recorder,
        workspace,
        "read_config(default_config_path()).get('project_id')",
        "from canyonos.constants import default_config_path, read_config",
    )
    assert project_id, f"no project_id in {workspace.name}'s global_controller.yaml"
    projects = api.get("/projects").json()
    names = {project["id"]: project["name"] for project in projects}
    assert names.get(project_id) == name, (
        f"the dashboard does not list {project_id} as {name}: {projects}"
    )
    return project_id


def redis_port(recorder: Recorder, workspace: Path) -> int:
    """The host port of the deployed project's Redis, as the CLI reads it."""
    return cli_value(
        recorder,
        workspace,
        "redis_port_of(load_state())",
        "from canyonos.init import load_state, redis_port_of",
    )


def deployed_endpoint(recorder: Recorder, workspace: Path) -> Endpoint:
    """Ask the running Global Controller for the endpoint, from the project folder."""
    endpoint = cli_value(
        recorder,
        workspace,
        "deployed_endpoint(load_state()['port'])",
        "from canyonos.gc import deployed_endpoint; from canyonos.init import load_state",
    )
    return Endpoint(
        url=f"http://127.0.0.1:{endpoint['api_port']}",
        route=endpoint["method"],
        argument=endpoint["arguments"][0],
        arguments=tuple(endpoint["arguments"]),
    )


def submit(recorder: Recorder, endpoint: Endpoint, query) -> str:
    """POST `query` to the endpoint as its first argument and return its request
    id."""
    url = f"{endpoint.url}/{endpoint.route}"
    call = http(recorder, "POST", url, json={endpoint.argument: query})
    return call.json()["request_id"]


def finished(recorder: Recorder, endpoint: Endpoint, request_id: str, *, timeout):
    """Poll `/status/<request_id>` until it is done or failed and return the status
    body. An unanswered request or a 5xx is retried, since the endpoint may be
    busy; a 4xx fails the call at once. Raise AssertionError with the last answer
    when `timeout` seconds pass first."""
    url = f"{endpoint.url}/status/{request_id}"
    answers: list[Call] = []

    def settled():
        call = http(recorder, "GET", url, check=False)
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


def project_containers(
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
