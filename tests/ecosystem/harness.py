# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Recorded calls for the ecosystem check: every CLI command, HTTP request and
Docker command a case makes goes through here, so a failure can show what went
in and what came out without the case doing anything extra."""

from __future__ import annotations

import base64
import json as _json
import os
import re
import subprocess
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

import requests

REPO_ROOT = Path(__file__).resolve().parents[2]
API_URL = "http://127.0.0.1:3000"
OUTPUT_LIMIT = 20_000
SIGN_IN_EMAIL = "ecosystem@canyonos.test"
FIXED_CODE = "111111"


@dataclass
class Call:
    """One recorded command or request: what was sent, what came back, how it ended."""

    kind: str
    label: str
    input: str
    output: str
    code: int
    seconds: float

    def json(self):
        """The output parsed as JSON."""
        return _json.loads(self.output)

    def as_dict(self) -> dict:
        """The call as a plain dict, ready for a JSON line, with a long output
        clipped to its head and tail."""
        return {**asdict(self), "output": _clip(self.output)}


class CallFailed(AssertionError):
    """A checked call ended with a non-zero exit code or an HTTP error status."""

    def __init__(self, call: Call):
        super().__init__(f"{call.label} -> {call.code}\n{call.output[-2000:]}")
        self.call = call


@dataclass
class Recorder:
    """The calls made so far in this session, in order."""

    calls: list[Call] = field(default_factory=list)

    def record(self, call: Call) -> Call:
        """Append `call` to the session and return it."""
        self.calls.append(call)
        return call

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


def cli_env() -> dict[str, str]:
    """The environment every `canyonos` command runs with: the images built from
    this checkout instead of the published ones."""
    return {
        **os.environ,
        "CANYONOS_ENV": "development",
        "CANYONOS_CORE_IMAGE": "local",
        "CANYONOS_API_IMAGE": "local",
        "CANYONOS_WEB_IMAGE": "local",
    }


def git_auth_env(token: str | None) -> dict[str, str]:
    """The environment that makes git fail fast instead of prompting and, given a
    token, send it as an HTTPS auth header the way actions/checkout does. The token
    travels in the environment only, never in the recorded argv."""
    env = {"GIT_TERMINAL_PROMPT": "0"}
    if not token:
        return env
    credentials = base64.b64encode(f"x-access-token:{token}".encode()).decode()
    return {
        **env,
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
        "GIT_CONFIG_VALUE_0": f"AUTHORIZATION: basic {credentials}",
    }


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
    `check`, a non-zero exit raises CallFailed carrying the call."""
    started = time.monotonic()
    try:
        completed = subprocess.run(
            argv,
            cwd=str(cwd),
            env=env,
            input=stdin,
            stdin=None if stdin is not None else subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        output, code = completed.stdout + completed.stderr, completed.returncode
    except subprocess.TimeoutExpired as expired:
        output = f"{_text(expired.stdout)}{_text(expired.stderr)}"
        output += f"\n[timed out after {timeout}s]"
        code = -1
    call = recorder.record(
        Call(
            kind=kind,
            label=" ".join(argv),
            input=stdin or "",
            output=output,
            code=code,
            seconds=round(time.monotonic() - started, 2),
        )
    )
    if check and code != 0:
        raise CallFailed(call)
    return call


def _text(stream: str | bytes | None) -> str:
    if isinstance(stream, bytes):
        return stream.decode(errors="replace")
    return stream or ""


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
    """The dashboard API as one signed-in user."""

    def __init__(self, recorder: Recorder, base_url: str, token: str):
        self.recorder = recorder
        self.base_url = base_url.rstrip("/")
        self.headers = {"Authorization": f"Bearer {token}"}

    def request(self, method: str, path: str, *, json=None, check: bool = True) -> Call:
        """Send `method` to `path` under the base URL with the bearer token."""
        return http(
            self.recorder,
            method,
            f"{self.base_url}{path}",
            json=json,
            headers=self.headers,
            check=check,
        )

    def get(self, path: str, **kwargs) -> Call:
        """GET `path`; keyword arguments go to `request`."""
        return self.request("GET", path, **kwargs)

    def post(self, path: str, **kwargs) -> Call:
        """POST to `path`; keyword arguments go to `request`."""
        return self.request("POST", path, **kwargs)

    def put(self, path: str, **kwargs) -> Call:
        """PUT to `path`; keyword arguments go to `request`."""
        return self.request("PUT", path, **kwargs)

    def delete(self, path: str, **kwargs) -> Call:
        """DELETE `path`; keyword arguments go to `request`."""
        return self.request("DELETE", path, **kwargs)


def sign_in(recorder: Recorder, base_url: str) -> str:
    """Sign in to the dashboard with the fixed code and return the bearer token."""
    call = http(
        recorder,
        "POST",
        f"{base_url}/auth/verify",
        json={"email": SIGN_IN_EMAIL, "code": FIXED_CODE},
    )
    return call.json()["token"]


def project_id(api: Api, name: str) -> str:
    """The dashboard id of the registered project called `name`."""
    projects = api.get("/projects").json()
    for project in projects:
        if project["name"] == name:
            return project["id"]
    raise AssertionError(f"{name} is not registered; dashboard lists {projects}")


def case_slug(module: str, name: str) -> str:
    """The directory name a case's trace goes under, safe for any filesystem."""
    return re.sub(r"[^A-Za-z0-9_-]", "_", f"{module}__{name}")


def collect_container_logs(
    recorder: Recorder, directory: Path, tail: int = 200
) -> None:
    """Write the last `tail` lines of every `canyonos*` container's log, running or
    not, into `directory`, one file per container."""
    directory.mkdir(parents=True, exist_ok=True)
    names = docker(
        recorder, ["ps", "-a", "--filter", "name=canyonos", "--format", "{{.Names}}"]
    ).output.split()
    for name in sorted(names):
        call = docker(recorder, ["logs", "--tail", str(tail), name], check=False)
        (directory / f"{name}.log").write_text(call.output)
