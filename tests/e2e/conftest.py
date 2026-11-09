# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Setup for the E2E check. `cases/` run against one project named by
`--project`: it is staged, the images are built from this checkout, it is deployed
once and sent its test query, and cases only assert. `scenarios/` need no
`--project`: each stages and deploys what it needs. A failing case gets its calls,
the doctor output and container logs written under the artifacts directory."""

from __future__ import annotations

import json
import os
import re
import traceback
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest
from dotenv import dotenv_values

from .harness import (
    API_URL,
    Api,
    CallFailed,
    Endpoint,
    Recorder,
    build_images,
    canyonos,
    case_slug,
    collect_container_logs,
    deployed_endpoint,
    deployed_project_id,
    manifest,
    project_group,
    query_for,
    result_of,
    sign_in,
    stage,
)
from .projects import Project, list_projects, load_check, load_project

PROJECT_KEY = pytest.StashKey[Project]()
CALL_START_KEY = pytest.StashKey[int]()
COLLECTED_FILE = "collected.json"
CASES_DIR = (Path(__file__).parent / "cases").resolve()
DEPLOY_TIMEOUT = 1800


def pytest_addoption(parser):
    parser.addoption("--project", help="name of a directory under tests/e2e/projects")
    parser.addoption("--artifacts-dir", help="where junit.xml and traces/ are written")


def pytest_configure(config):
    """Register the `trait` marker, read tests/e2e/.env for local runs, and load
    the project named by `--project`."""
    config.addinivalue_line(
        "markers",
        "trait(*names): run only for projects whose project.yaml lists every name",
    )
    load_dotenv(Path(__file__).parent / ".env")
    name = config.getoption("--project")
    if name is None:
        return
    try:
        config.stash[PROJECT_KEY] = load_project(name)
    except FileNotFoundError as error:
        raise pytest.UsageError(str(error)) from error


def load_dotenv(path: Path) -> None:
    """Read `path` into the environment with python-dotenv, the reader the CLI
    uses for its own `.env` (quotes and `export` handled); variables already set
    win."""
    if not path.is_file():
        return
    for key, value in dotenv_values(path).items():
        if value is not None:
            os.environ.setdefault(key, value)


def _traits_of(item) -> set[str]:
    return {name for marker in item.iter_markers("trait") for name in marker.args}


def pytest_collection_modifyitems(config, items):
    """Stop with a usage error when cases are collected without `--project` or a
    trait marker names a trait no project.yaml lists, and deselect the cases whose
    traits the project does not all list."""
    known = {trait for name in list_projects() for trait in load_project(name).traits}
    unknown = {
        f"{item.nodeid}: {trait}"
        for item in items
        for trait in _traits_of(item) - known
    }
    if unknown:
        raise pytest.UsageError(
            f"unknown trait, listed by no project.yaml: {', '.join(sorted(unknown))}"
        )
    is_case = [Path(item.path).resolve().is_relative_to(CASES_DIR) for item in items]
    if PROJECT_KEY not in config.stash:
        if any(is_case):
            raise pytest.UsageError(
                "--project is required: one of tests/e2e/projects/*"
            )
        return
    traits = set(config.stash[PROJECT_KEY].traits)
    keep, drop = [], []
    for item in items:
        (keep if _traits_of(item) <= traits else drop).append(item)
    items[:] = keep
    if drop:
        config.hook.pytest_deselected(items=drop)


def pytest_collection_finish(session):
    """Write the cases this run will run to collected.json under `--artifacts-dir`,
    named as junit.xml names them, so report.py can tell a case that never ran
    (a run cut short) from one that passed."""
    option = session.config.getoption("--artifacts-dir")
    if not option:
        return
    directory = Path(option)
    directory.mkdir(parents=True, exist_ok=True)
    cases = [_junit_name(item.nodeid) for item in session.items]
    (directory / COLLECTED_FILE).write_text(json.dumps(cases, indent=1) + "\n")


def _junit_name(nodeid: str) -> dict[str, str]:
    """The classname and name junit.xml gives the case `nodeid`, pytest's rule."""
    path, bracket, params = nodeid.partition("[")
    names = path.split("::")
    names[0] = re.sub(r"\.py$", "", names[0].replace("/", "."))
    names[-1] += bracket + params
    return {"classname": ".".join(names[:-1]), "name": names[-1]}


@pytest.fixture(scope="session")
def project(request) -> Project:
    """The project named by `--project`."""
    return request.config.stash[PROJECT_KEY]


def session_recorder(session) -> Recorder:
    """The recorder kept on the session, created on first use: hooks and fixtures
    share it, so a trace can include the calls of session fixtures."""
    if not hasattr(session, "e2e_recorder"):
        session.e2e_recorder = Recorder()
    return session.e2e_recorder


@pytest.fixture(scope="session")
def recorder(request) -> Recorder:
    """Every call the session makes, for the traces of failing cases."""
    return session_recorder(request.session)


@pytest.fixture(scope="session", autouse=True)
def artifacts_dir(request, tmp_path_factory) -> Path:
    """Where traces/ and junit.xml go: `--artifacts-dir`, or a pytest temp folder."""
    option = request.config.getoption("--artifacts-dir")
    directory = Path(option) if option else tmp_path_factory.mktemp("e2e")
    directory.mkdir(parents=True, exist_ok=True)
    request.session.e2e_artifacts = directory
    return directory


@pytest.fixture(scope="session")
def check(project):
    """The project's check.py, which says what is wrong with a workflow result."""
    return load_check(project)


def secrets_of(project: Project) -> dict[str, str]:
    """The values of the secrets the project declares, from the environment."""
    missing = [name for name in project.secrets if not os.environ.get(name)]
    if missing:
        raise pytest.UsageError(
            f"{project.name} needs {', '.join(missing)} in the environment "
            "(or tests/e2e/.env)"
        )
    return {name: os.environ[name] for name in project.secrets}


@pytest.fixture(scope="session")
def images(recorder) -> None:
    """The core, api and web images built from this checkout, unless CI built them."""
    build_images(recorder)


@pytest.fixture(scope="session")
def workspace(request, project, recorder, tmp_path_factory) -> Path:
    """The project staged in a folder named after it."""
    staged = stage(
        recorder, project, tmp_path_factory.mktemp("workspace"), secrets_of(project)
    )
    request.session.e2e_workspace = staged
    return staged


@dataclass(frozen=True)
class Deployed:
    """A project that `canyonos deploy` brought up, with the handles cases need.
    `agents` names every agent in the manifest; a `type: database` agent runs
    replicas named the same way, from its stock image."""

    project: Project
    dir: Path
    group: str
    endpoint: Endpoint
    api: Api
    project_id: str
    agents: list[str]
    query: object
    deploy_output: str


@dataclass(frozen=True)
class QueryResult:
    """The project's test query after it finished: its request id and its result."""

    request_id: str
    result: object


@pytest.fixture(scope="session")
def deployed(project, recorder, workspace, images, artifacts_dir) -> Iterator[Deployed]:
    """Deploy the staged project with `canyonos deploy`, sign in to the dashboard
    and hand cases the endpoint and API. Afterwards, and also when any of that
    fails, save the container logs and remove the deploy with `canyonos stop`. A
    failing stop fails the run, unless the deploy had already failed: that failure
    is the one reported."""
    succeeded = False
    try:
        deploy = canyonos(recorder, ["deploy"], cwd=workspace, timeout=DEPLOY_TIMEOUT)
        assert f"Registered {project.name} with the dashboard" in deploy.output, (
            deploy.output[-3000:]
        )
        api = Api(recorder, API_URL, sign_in(recorder, API_URL))
        yield Deployed(
            project=project,
            dir=workspace,
            group=project_group(recorder, workspace),
            endpoint=deployed_endpoint(recorder, workspace),
            api=api,
            project_id=deployed_project_id(recorder, api, workspace, project.name),
            agents=[agent["name"] for agent in manifest(workspace).get("agents", [])],
            query=query_for(project, workspace),
            deploy_output=deploy.output,
        )
        succeeded = True
    finally:
        _tear_down(recorder, workspace, artifacts_dir, raise_on_failure=succeeded)


def _tear_down(recorder, workspace: Path, artifacts_dir: Path, *, raise_on_failure):
    """Save every container's log under containers/, then run `canyonos stop`; with
    `raise_on_failure`, a failed stop raises CallFailed."""
    try:
        collect_container_logs(recorder, artifacts_dir / "containers")
    except Exception:
        (artifacts_dir / "containers_error.txt").write_text(traceback.format_exc())
    stop = canyonos(recorder, ["stop"], cwd=workspace, check=False)
    if raise_on_failure and stop.code != 0:
        raise CallFailed(stop)


@pytest.fixture(scope="session")
def query_result(deployed, recorder) -> QueryResult:
    """The project's test query sent once to the endpoint and polled to its result."""
    request_id, result = result_of(
        recorder, deployed.endpoint, deployed.query, timeout=deployed.project.timeout
    )
    return QueryResult(request_id=request_id, result=result)


@pytest.hookimpl(tryfirst=True)
def pytest_runtest_setup(item):
    """Note where `item`'s calls start before its fixtures are set up, so its trace
    also holds the calls of the session fixtures it is the first to need."""
    item.stash[CALL_START_KEY] = len(session_recorder(item.session).calls)


def _projects_of(item, start: int) -> list[Path]:
    """The project folders a failing case's doctor runs in: those staged since its
    calls started, else the session's staged project (cases only). A scenario
    whose project an earlier scenario's fixture staged gets none."""
    staged = session_recorder(item.session).staged_since(start)
    workspace = getattr(item.session, "e2e_workspace", None)
    return staged or ([workspace] if workspace is not None else [])


def _write_trace(item, report, slug: str, start: int) -> None:
    """Write the calls from `start` on, the failure, `canyonos doctor` output from
    each project folder `_projects_of` names and container logs under
    traces/<slug>; leave an existing trace as it is. A failing doctor or log step
    goes to trace_error.txt so the case's own failure still shows."""
    recorder = session_recorder(item.session)
    directory = item.session.e2e_artifacts / "traces" / slug
    try:
        directory.mkdir(parents=True)
    except FileExistsError:
        return
    recorder.dump(directory / "calls.jsonl", start=start)
    (directory / "longrepr.txt").write_text(report.longreprtext)
    try:
        doctors = []
        for workspace in _projects_of(item, start):
            if workspace.is_dir():
                doctor = canyonos(
                    recorder, ["doctor"], cwd=workspace, check=False, timeout=120
                )
                doctors.append(f"## {workspace.name}\n{doctor.output}")
        if doctors:
            (directory / "doctor.txt").write_text("\n".join(doctors))
        collect_container_logs(recorder, directory / "containers")
    except Exception:
        (directory / "trace_error.txt").write_text(traceback.format_exc())


def _same_setup_failure(item, error: BaseException | None, slug: str) -> str | None:
    """The slug of the trace an earlier case wrote for the very same setup error,
    which pytest raises again for each case that needs the failed fixture; None
    the first time, after noting `slug` for it."""
    seen = item.session.__dict__.setdefault("e2e_setup_errors", [])
    for earlier, earlier_slug in seen:
        if error is not None and earlier is error:
            return earlier_slug
    seen.append((error, slug))
    return None


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    """Write a trace when a case's setup or call fails, under the case's name. A
    setup failure goes under setup__<case>; a later case that fails on the same
    setup error gets only a same_as.txt naming the first trace."""
    outcome = yield
    report = outcome.get_result()
    if not report.failed or report.when not in ("setup", "call"):
        return
    if not hasattr(item.session, "e2e_artifacts"):
        return
    module = item.nodeid.split("::")[0].rsplit("/", 1)[-1].removesuffix(".py")
    slug = case_slug(module, item.name)
    start = item.stash.get(CALL_START_KEY, 0)
    if report.when == "call":
        _write_trace(item, report, slug, start)
        return
    setup_slug = f"setup__{slug}"
    error = call.excinfo.value if call.excinfo is not None else None
    first = _same_setup_failure(item, error, setup_slug)
    if first is None:
        _write_trace(item, report, setup_slug, start)
        return
    directory = item.session.e2e_artifacts / "traces" / setup_slug
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "same_as.txt").write_text(first + "\n")


def pytest_sessionfinish(session, exitstatus):
    """Write every call of the run to calls.jsonl and show where its artifacts went."""
    artifacts = getattr(session, "e2e_artifacts", None)
    if artifacts is None:
        return
    session_recorder(session).dump(artifacts / "calls.jsonl")
    print(f"\ne2e artifacts: {artifacts}")
