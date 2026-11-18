# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The Global Controller's HTTP API, as the CLI and platform-api call it, with the
headers the CLI saved: its OpenAPI spec lists every route, each answer has the fields
and types the spec gives it, each error carries its code, a call without those headers
is refused, a rejected upload changes nothing, and uploading what already runs keeps the
project's fingerprints and applies as nothing."""

import io
import tarfile

from canyonos_core.canyonos_api_interface import models

from ..harness import canyonos, cli_python, controller_headers, http, poll

ROUTES = {
    ("/v1/deployments", "get"),
    ("/v1/deployments/{deployment_id}", "put"),
    ("/v1/deployments/{deployment_id}", "get"),
    ("/v1/deployments/{deployment_id}", "delete"),
    ("/v1/deployments/{deployment_id}/projects/{name}", "put"),
    ("/v1/deployments/{deployment_id}/projects/{name}", "delete"),
    ("/v1/deployments/{deployment_id}/logs/controller", "get"),
    ("/v1/deployments/{deployment_id}/logs/agents/{name}", "get"),
    ("/v1/deployments/{deployment_id}/health", "get"),
    ("/v1/deployments/{deployment_id}/projects", "get"),
    ("/v1/deployments/{deployment_id}/projects/{name}", "get"),
    ("/v1/deployments/{deployment_id}/dashboard", "put"),
}
GZIP = {"Content-Type": "application/gzip"}


def _controller(recorder, deployed):
    return canyonos(recorder, ["status", "--json"], cwd=deployed.dir).json()[
        "controller_url"
    ]


def _answer(call, model):
    """`call`'s JSON body, checked against the spec's `model`: no field the model
    lacks, every field it requires, each of its type."""
    body = call.json()
    required = {
        name for name, field in model.model_fields.items() if field.is_required()
    }
    assert required <= set(body) <= set(model.model_fields), call.output
    model.model_validate_json(call.output, strict=True)
    return body


def _status(recorder, deployment, auth):
    return _answer(http(recorder, "GET", deployment, headers=auth), models.Status)


def test_spec_lists_every_route(recorder, deployed):
    url = _controller(recorder, deployed)
    auth = controller_headers(recorder, deployed.dir)
    spec = http(recorder, "GET", f"{url}/openapi/openapi.json", headers=auth).json()
    routes = {(path, method) for path, item in spec["paths"].items() for method in item}
    assert routes == ROUTES, sorted(routes)
    status = _status(recorder, f"{url}/v1/deployments/{deployed.project_id}", auth)
    assert spec["info"]["version"] == status["version"], spec["info"]


def test_reads_match_the_spec(recorder, deployed):
    url = _controller(recorder, deployed)
    auth = controller_headers(recorder, deployed.dir)
    deployments = http(recorder, "GET", f"{url}/v1/deployments", headers=auth)
    held = {"deployment_id": deployed.project_id, "name": deployed.dir.name}
    assert _answer(deployments, models.Deployments)["deployments"] == [held], held
    url = f"{url}/v1/deployments/{deployed.project_id}"
    status = _status(recorder, url, auth)
    assert status["phase"] == "up", status
    assert status["applied_generation"] == status["generation"], status
    assert status["last_apply"]["ok"], status
    assert status["name"] == deployed.dir.name, status
    assert status["config"] == (deployed.dir / "deployment.yaml").read_text(), status
    project = status["endpoint"]["routes"][0]["project"]
    listed = _answer(
        http(recorder, "GET", f"{url}/projects", headers=auth), models.Projects
    )["projects"]
    one = http(recorder, "GET", f"{url}/projects/{project}", headers=auth)
    assert _answer(one, models.Project) in listed, (one.output, listed)
    health = _answer(
        http(recorder, "GET", f"{url}/health", headers=auth), models.Health
    )
    assert health["ok"], health
    agent = deployed.agents[0]
    logs = http(recorder, "GET", f"{url}/logs/agents/{agent}?tail=5", headers=auth)
    assert _answer(logs, models.ReplicaLogs)["logs"], logs.output
    log = http(recorder, "GET", f"{url}/logs/controller?tail=5", headers=auth).output
    assert 0 < len(log.splitlines()) <= 5, log


def test_errors_carry_their_code(recorder, deployed):
    url = _controller(recorder, deployed)
    auth = controller_headers(recorder, deployed.dir)
    prefix = f"/v1/deployments/{deployed.project_id}"
    project = _status(recorder, f"{url}{prefix}", auth)["endpoint"]["routes"][0][
        "project"
    ]
    before = _status(recorder, f"{url}{prefix}", auth)["generation"]
    broken = io.BytesIO()
    with tarfile.open(fileobj=broken, mode="w:gz") as archive:
        config = b"agents: 3\n"
        info = tarfile.TarInfo("config/workflow_config.yaml")
        info.size = len(config)
        archive.addfile(info, io.BytesIO(config))
    rejected = [
        ("GET", prefix, {"headers": {}}, 401, "unauthenticated"),
        (
            "PUT",
            "/v1/deployments/no-such",
            {"json": {"name": "x"}},
            404,
            "unknown_deployment",
        ),
        ("GET", f"{prefix}/logs/controller?tail=lots", {}, 400, "bad_request"),
        ("GET", f"{prefix}/logs/agents/NoSuchAgent", {}, 404, "unknown_agent"),
        ("PUT", prefix, {"json": {"name": "x"}}, 400, "bad_request"),
        ("GET", f"{prefix}/projects/no-such", {}, 404, "unknown_project"),
        ("DELETE", f"{prefix}/projects/no-such", {}, 404, "unknown_project"),
        (
            "PUT",
            f"{prefix}/projects/{project}",
            {"data": b"not a tar", "headers": {**GZIP, **auth}},
            400,
            "bad_archive",
        ),
        (
            "PUT",
            f"{prefix}/projects/{project}",
            {"data": broken.getvalue(), "headers": {**GZIP, **auth}},
            400,
            "project_invalid",
        ),
    ]
    for method, path, body, status, code in rejected:
        call = http(
            recorder, method, f"{url}{path}", check=False, **{"headers": auth, **body}
        )
        assert call.code == status, call.output
        assert _answer(call, models.Error)["code"] == code, call.output
    assert call.json()["findings"], call.output
    after = _status(recorder, f"{url}{prefix}", auth)
    assert after["generation"] == before and after["phase"] == "up", after


def test_uploading_what_runs_changes_nothing(recorder, deployed, tmp_path):
    url = f"{_controller(recorder, deployed)}/v1/deployments/{deployed.project_id}"
    auth = controller_headers(recorder, deployed.dir)
    project = _status(recorder, url, auth)["endpoint"]["routes"][0]["project"]
    project_url = f"{url}/projects/{project}"
    before = http(recorder, "GET", project_url, headers=auth).json()["fingerprints"]
    env = deployed.dir / ".env"
    body = {
        "name": deployed.dir.name,
        "config": (deployed.dir / "deployment.yaml").read_text("utf-8"),
        "env": env.read_text("utf-8") if env.is_file() else None,
    }
    http(recorder, "PUT", url, json=body, headers=auth)
    # Built by the CLI's own code, in its environment, so it is the upload a sync sends.
    archive = tmp_path / "project.tar.gz"
    cli_python(
        recorder,
        deployed.dir,
        "import shutil; from canyonos.sync import project_archive; "
        f"shutil.copyfileobj(project_archive({str(deployed.project_dir)!r}), "
        f"open({str(archive)!r}, 'wb'))",
    )
    upload = http(
        recorder,
        "PUT",
        project_url,
        data=archive.read_bytes(),
        headers={**GZIP, **auth},
    )
    generation = _answer(upload, models.Uploaded)["generation"]

    def applied():
        status = _status(recorder, url, auth)
        return status if status["applied_generation"] >= generation else None

    status = poll(applied, timeout=60, interval=1, what=f"generation {generation}")
    assert status["last_apply"]["action"] == "none", status["last_apply"]
    assert status["phase"] == "up", status
    after = http(recorder, "GET", project_url, headers=auth).json()["fingerprints"]
    assert after == before, (before, after)
