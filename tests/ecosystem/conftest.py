# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Setup for one project of the ecosystem check: clone it at its pinned commit,
build the images from this checkout, deploy, sign in to the dashboard when it asks
for an account, and send one query. Cases then only assert. A failing case gets its
calls, the doctor output and container logs written under the artifacts directory."""

from __future__ import annotations

import json
import os
import shutil
import traceback
from dataclasses import dataclass
from pathlib import Path

import pytest
import yaml

from .harness import (
    API_URL,
    REPO_ROOT,
    Api,
    Recorder,
    canyonos,
    case_slug,
    collect_container_logs,
    docker,
    git_auth_env,
    http,
    poll,
    project_id,
    run,
    sign_in,
)
from .projects import Project, load_check, load_project

PROJECT_KEY = pytest.StashKey[Project]()
CALL_START_KEY = pytest.StashKey[int]()
CASES_DIR = Path(__file__).parent / "cases"
DEPLOY_TIMEOUT = 1800
BUILD_TIMEOUT = 1800
STATUS_POLL_INTERVAL = 5


def pytest_addoption(parser):
    """Add `--project` and `--artifacts-dir` to the pytest command line."""
    parser.addoption(
        "--project", help="name of a directory under tests/ecosystem/projects"
    )
    parser.addoption("--artifacts-dir", help="where junit.xml and traces/ are written")


def names_cases(config) -> bool:
    """Whether a path given to pytest is cases/ or inside it, so the run asked for
    cases explicitly rather than reaching them from a parent directory."""
    base = config.invocation_params.dir
    paths = [(base / arg.split("::")[0]).resolve() for arg in config.args]
    return any(path.is_relative_to(CASES_DIR) for path in paths)


def is_case(item) -> bool:
    """Whether `item` is a case under cases/, which needs a project to run."""
    return Path(item.path).resolve().is_relative_to(CASES_DIR)


def pytest_configure(config):
    """Register the `trait` marker and load the project named by `--project`."""
    config.addinivalue_line(
        "markers", "trait(name): run only for projects whose project.yaml lists `name`"
    )
    name = config.getoption("--project")
    if name is None:
        return
    try:
        config.stash[PROJECT_KEY] = load_project(name)
    except FileNotFoundError as error:
        raise pytest.UsageError(str(error)) from error


def select_by_traits(items, traits):
    """Split collected items into the ones to run and the ones whose trait the
    project lacks."""
    keep, drop = [], []
    for item in items:
        marker = item.get_closest_marker("trait")
        if marker is None or marker.args[0] in traits:
            keep.append(item)
        else:
            drop.append(item)
    return keep, drop


def pytest_collection_modifyitems(config, items):
    """Deselect the cases marked with a trait the project's project.yaml does not
    list. Without `--project`, deselect every case, so `pytest tests` still runs
    the rest, and stop with a usage error when cases were named explicitly."""
    if PROJECT_KEY not in config.stash:
        if names_cases(config):
            raise pytest.UsageError(
                "--project is required: one of tests/ecosystem/projects/*"
            )
        keep = [item for item in items if not is_case(item)]
        drop = [item for item in items if is_case(item)]
    else:
        keep, drop = select_by_traits(items, set(config.stash[PROJECT_KEY].traits))
    items[:] = keep
    if drop:
        config.hook.pytest_deselected(items=drop)


@pytest.fixture(scope="session")
def project(request) -> Project:
    """The project named by `--project`."""
    return request.config.stash[PROJECT_KEY]


def session_recorder(session) -> Recorder:
    """The recorder kept on the session, created on first use: hooks and fixtures
    share it, so a trace can include the calls of session fixtures."""
    if not hasattr(session, "_ecosystem_recorder"):
        session._ecosystem_recorder = Recorder()
    return session._ecosystem_recorder


def pytest_sessionstart(session):
    """Create the session's recorder before any fixture or hook needs it."""
    session_recorder(session)


@pytest.fixture(scope="session")
def recorder(request) -> Recorder:
    """Every call the session makes, for the traces of failing cases."""
    return session_recorder(request.session)


@pytest.fixture(scope="session")
def artifacts_dir(request, tmp_path_factory) -> Path:
    """Where traces/ and junit.xml go: `--artifacts-dir`, or a pytest temp folder
    when it is not given."""
    option = request.config.getoption("--artifacts-dir")
    directory = Path(option) if option else tmp_path_factory.mktemp("ecosystem")
    directory.mkdir(parents=True, exist_ok=True)
    return directory


@pytest.fixture(scope="session")
def check(project):
    """The project's check.py, which says what is wrong with a workflow result."""
    return load_check(project)


def _require_secrets(project: Project) -> dict[str, str]:
    missing = [name for name in project.secrets if not os.environ.get(name)]
    if missing:
        raise pytest.UsageError(
            f"{project.name} needs {', '.join(missing)} in the environment "
            "(or tests/ecosystem/.env)"
        )
    return {name: os.environ[name] for name in project.secrets}


def _load_dotenv():
    """Read tests/ecosystem/.env into the environment for local runs, the way
    tests/e2e/run.sh reads tests/e2e/.env. Shell variables win."""
    path = Path(__file__).parent / ".env"
    if not path.is_file():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


def _write_env(workspace: Path, secrets: dict[str, str]) -> None:
    """Rewrite the port's .env: keep its non-secret settings, drop any committed
    line for a declared secret, then append the real values."""
    path = workspace / ".env"
    kept = []
    if path.is_file():
        for line in path.read_text().splitlines():
            key = line.split("=", 1)[0].lstrip("#").strip()
            if key in secrets:
                continue
            kept.append(line)
    lines = [*kept, "", *(f"{key}={value}" for key, value in secrets.items()), ""]
    path.write_text("\n".join(lines))


@pytest.fixture(scope="session")
def workspace(request, project, recorder, tmp_path_factory) -> Path:
    """The project cloned at its pinned commit and staged in a folder named after
    it, with its .env filled in from the environment."""
    _load_dotenv()
    secrets = _require_secrets(project)
    clone = tmp_path_factory.mktemp("clone")
    git = ["git", "-c", "advice.detachedHead=false"]
    env = {**os.environ, **git_auth_env(os.environ.get("ECOSYSTEM_GIT_TOKEN"))}
    run(
        recorder,
        [
            *git,
            "clone",
            "--filter=blob:none",
            "--no-checkout",
            project.clone_url,
            str(clone),
        ],
        cwd=clone.parent,
        env=env,
    )
    run(recorder, [*git, "sparse-checkout", "set", project.path], cwd=clone, env=env)
    run(recorder, [*git, "checkout", project.ref], cwd=clone, env=env)
    staged = tmp_path_factory.mktemp("workspace") / project.name
    shutil.copytree(clone / project.path, staged, symlinks=True)
    _write_env(staged, secrets)
    request.session._ecosystem_workspace = staged
    return staged


@pytest.fixture(scope="session")
def images(recorder) -> None:
    """Build canyonos-core:dev, canyonos-api:dev and canyonos-web:dev from this
    checkout, the images `canyonos deploy` uses in development mode."""
    builds = [
        ["-f", "packages/core/Dockerfile", "-t", "canyonos-core:dev", "packages/core"],
        ["-f", "packages/api/Dockerfile", "-t", "canyonos-api:dev", "."],
        [
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
    ]
    for args in builds:
        docker(recorder, ["build", "--progress=plain", *args], timeout=BUILD_TIMEOUT)


@dataclass(frozen=True)
class Deployed:
    """A project that `canyonos deploy` brought up, with the handles cases need."""

    project: Project
    dir: Path
    endpoint_url: str
    route: str
    argument: str
    api: Api
    project_id: str
    agents: list[str]
    query: str


@dataclass(frozen=True)
class QueryResult:
    """The project's test query after it finished: its request id and its result."""

    request_id: str
    result: object


def _agent_names(workspace: Path) -> list[str]:
    with (workspace / ".canyon" / "config" / "global_controller.yaml").open() as handle:
        config = yaml.safe_load(handle)
    return [agent["name"] for agent in config.get("agents", [])]


def endpoint_from_output(output: str) -> dict:
    """The JSON object line the endpoint script wrote to stdout, found from the end
    because uv, warnings and logs on stderr come after it in a recorded output."""
    for line in reversed(output.splitlines()):
        if not line.lstrip().startswith("{"):
            continue
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    raise AssertionError(f"no endpoint JSON line in the output:\n{output[-3000:]}")


def _endpoint(recorder: Recorder, workspace: Path) -> tuple[str, str, str]:
    """api_port, route and argument name of the running deploy, read the way
    tests/e2e/run.sh does: from the Global Controller, in the project directory."""
    script = (
        "import json; from canyonos.gc import deployed_endpoint; "
        "from canyonos.init import load_state; "
        "e = deployed_endpoint(load_state()['port']); "
        "print(json.dumps({'api_port': e['api_port'], 'method': e['method'], "
        "'argument': e['arguments'][0]}))"
    )
    output = run(
        recorder,
        ["uv", "run", "--project", str(REPO_ROOT), "--frozen", "python", "-c", script],
        cwd=workspace,
    ).output
    endpoint = endpoint_from_output(output)
    return str(endpoint["api_port"]), endpoint["method"], endpoint["argument"]


@pytest.fixture(scope="session")
def deployed(project, recorder, workspace, images, artifacts_dir) -> Deployed:
    """Deploy the staged project with `canyonos deploy`, sign in to the dashboard if
    it runs with accounts, and hand cases the endpoint and API; afterwards save the container logs under
    the artifacts directory and remove the deploy with `canyonos quit`."""
    canyonos(recorder, ["quit"], cwd=workspace, check=False)
    deploy = canyonos(recorder, ["deploy"], cwd=workspace, timeout=DEPLOY_TIMEOUT)
    assert f"Registered {project.name} with the dashboard" in deploy.output, (
        deploy.output[-3000:]
    )
    api_port, route, argument = _endpoint(recorder, workspace)
    api = Api(recorder, API_URL, sign_in(recorder, API_URL))
    query = (workspace / ".canyon" / "config" / "test_query.txt").read_text().strip()
    yield Deployed(
        project=project,
        dir=workspace,
        endpoint_url=f"http://127.0.0.1:{api_port}",
        route=route,
        argument=argument,
        api=api,
        project_id=project_id(api, project.name),
        agents=_agent_names(workspace),
        query=query,
    )
    try:
        collect_container_logs(recorder, artifacts_dir / "containers")
    finally:
        canyonos(recorder, ["quit"], cwd=workspace, check=False)


@pytest.fixture(scope="session")
def query_result(deployed, recorder) -> QueryResult:
    """The project's test query sent once to the deployed endpoint, polled to its
    result within the project's timeout."""
    url = f"{deployed.endpoint_url}/{deployed.route}"
    request_id = http(
        recorder, "POST", url, json={deployed.argument: deployed.query}
    ).json()["request_id"]

    def finished():
        status = http(
            recorder, "GET", f"{deployed.endpoint_url}/status/{request_id}"
        ).json()
        if status["status"] == "error":
            raise AssertionError(f"workflow error: {status.get('error')}")
        return status if status["status"] == "done" else None

    status = poll(
        finished,
        timeout=deployed.project.timeout,
        interval=STATUS_POLL_INTERVAL,
        what="the query to finish",
    )
    return QueryResult(request_id=request_id, result=status["result"])


@pytest.hookimpl(tryfirst=True)
def pytest_runtest_setup(item):
    """Note where `item`'s calls start before its fixtures are set up, so its trace
    also holds the calls of the session fixtures it is the first to need."""
    item.stash[CALL_START_KEY] = len(session_recorder(item.session).calls)


@pytest.fixture(scope="session", autouse=True)
def _expose_artifacts_dir(request, artifacts_dir):
    """Let the report hooks reach the artifacts directory, a fixture and so
    invisible to hooks."""
    request.session._ecosystem_artifacts = artifacts_dir


def writes_traces(item) -> bool:
    """Whether a failure of `item` gets a trace: only in a project run whose
    artifacts directory is set, never in a selftest run."""
    return PROJECT_KEY in item.config.stash and hasattr(
        item.session, "_ecosystem_artifacts"
    )


def _write_trace(item, report, slug: str, start: int) -> None:
    """Write the calls from `start` on, the failure, `canyonos doctor` output and
    container logs under traces/<slug>; leave an existing trace as it is. A failing
    doctor or log step goes to trace_error.txt so the case's own failure still shows."""
    recorder = session_recorder(item.session)
    artifacts: Path = item.session._ecosystem_artifacts
    directory = artifacts / "traces" / slug
    try:
        directory.mkdir(parents=True)
    except FileExistsError:
        return
    recorder.dump(directory / "calls.jsonl", start=start)
    (directory / "longrepr.txt").write_text(report.longreprtext)
    try:
        workspace = getattr(item.session, "_ecosystem_workspace", None)
        if workspace is not None:
            doctor = canyonos(
                recorder, ["doctor"], cwd=workspace, check=False, timeout=120
            )
            (directory / "doctor.txt").write_text(doctor.output)
        collect_container_logs(recorder, directory / "containers")
    except Exception:
        (directory / "trace_error.txt").write_text(traceback.format_exc())


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    """Write a trace when a case's setup or call fails: a setup failure goes under
    traces/setup once, a case failure under the case's own name."""
    outcome = yield
    report = outcome.get_result()
    if not report.failed or report.when not in ("setup", "call"):
        return
    if not writes_traces(item):
        return
    if report.when == "setup":
        _write_trace(item, report, "setup", start=0)
        return
    module = item.nodeid.split("::")[0].rsplit("/", 1)[-1].removesuffix(".py")
    start = item.stash.get(CALL_START_KEY, 0)
    _write_trace(item, report, case_slug(module, item.name), start)


def pytest_sessionfinish(session, exitstatus):
    """Write every call of a project run to calls.jsonl and show where its artifacts
    went; selftest runs write none worth finding."""
    artifacts = getattr(session, "_ecosystem_artifacts", None)
    if artifacts is None or PROJECT_KEY not in session.config.stash:
        return
    session_recorder(session).dump(artifacts / "calls.jsonl")
    print(f"\necosystem artifacts: {artifacts}")
