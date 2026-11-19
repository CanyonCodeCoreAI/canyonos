# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The Global Controller's HTTP API, as the CLI and platform-api call it, with the
headers the CLI saved: its OpenAPI spec lists every route, each answer has the fields
and types the spec gives it, each error carries its code, a call without those headers
is refused, a rejected upload changes nothing, and uploading what already runs keeps the
workflow's fingerprints and applies as nothing."""

import io
import tarfile

from canyonos_core.canyonos_api_interface import models

from ..harness import canyonos, cli_python, controller_headers, http, poll

ROUTES = {
    ("/v1/workflow-groups", "get"),
    ("/v1/workflow-groups/{workflow_group_id}", "put"),
    ("/v1/workflow-groups/{workflow_group_id}", "get"),
    ("/v1/workflow-groups/{workflow_group_id}", "delete"),
    ("/v1/workflow-groups/{workflow_group_id}/workflows/{name}", "put"),
    ("/v1/workflow-groups/{workflow_group_id}/workflows/{name}", "delete"),
    ("/v1/workflow-groups/{workflow_group_id}/logs/controller", "get"),
    ("/v1/workflow-groups/{workflow_group_id}/logs/agents/{name}", "get"),
    ("/v1/workflow-groups/{workflow_group_id}/health", "get"),
    ("/v1/workflow-groups/{workflow_group_id}/workflows", "get"),
    ("/v1/workflow-groups/{workflow_group_id}/workflows/{name}", "get"),
    ("/v1/workflow-groups/{workflow_group_id}/dashboard", "put"),
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


def _status(recorder, workflow_group, auth):
    return _answer(http(recorder, "GET", workflow_group, headers=auth), models.Status)


def test_spec_lists_every_route(recorder, deployed):
    url = _controller(recorder, deployed)
    auth = controller_headers(recorder, deployed.dir)
    spec = http(recorder, "GET", f"{url}/openapi/openapi.json", headers=auth).json()
    routes = {(path, method) for path, item in spec["paths"].items() for method in item}
    assert routes == ROUTES, sorted(routes)
    status = _status(
        recorder, f"{url}/v1/workflow-groups/{deployed.workflow_group_id}", auth
    )
    assert spec["info"]["version"] == status["version"], spec["info"]


def test_reads_match_the_spec(recorder, deployed):
    url = _controller(recorder, deployed)
    auth = controller_headers(recorder, deployed.dir)
    workflow_groups = http(recorder, "GET", f"{url}/v1/workflow-groups", headers=auth)
    held = {"workflow_group_id": deployed.workflow_group_id, "name": deployed.dir.name}
    answer = _answer(workflow_groups, models.WorkflowGroups)
    assert answer["workflow_groups"] == [held], held
    url = f"{url}/v1/workflow-groups/{deployed.workflow_group_id}"
    status = _status(recorder, url, auth)
    assert status["phase"] == "up", status
    assert status["applied_generation"] == status["generation"], status
    assert status["last_apply"]["ok"], status
    assert status["name"] == deployed.dir.name, status
    config = (deployed.dir / "workflow_group.yaml").read_text()
    assert status["config"] == config, status
    workflow = status["endpoint"]["routes"][0]["workflow"]
    listed = _answer(
        http(recorder, "GET", f"{url}/workflows", headers=auth), models.Workflows
    )["workflows"]
    one = http(recorder, "GET", f"{url}/workflows/{workflow}", headers=auth)
    assert _answer(one, models.Workflow) in listed, (one.output, listed)
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
    prefix = f"/v1/workflow-groups/{deployed.workflow_group_id}"
    workflow = _status(recorder, f"{url}{prefix}", auth)["endpoint"]["routes"][0][
        "workflow"
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
            "/v1/workflow-groups/no-such",
            {"json": {"name": "x"}},
            404,
            "unknown_workflow_group",
        ),
        ("GET", f"{prefix}/logs/controller?tail=lots", {}, 400, "bad_request"),
        ("GET", f"{prefix}/logs/agents/NoSuchAgent", {}, 404, "unknown_agent"),
        ("PUT", prefix, {"json": {"name": "x"}}, 400, "bad_request"),
        ("GET", f"{prefix}/workflows/no-such", {}, 404, "unknown_workflow"),
        ("DELETE", f"{prefix}/workflows/no-such", {}, 404, "unknown_workflow"),
        (
            "PUT",
            f"{prefix}/workflows/{workflow}",
            {"data": b"not a tar", "headers": {**GZIP, **auth}},
            400,
            "bad_archive",
        ),
        (
            "PUT",
            f"{prefix}/workflows/{workflow}",
            {"data": broken.getvalue(), "headers": {**GZIP, **auth}},
            400,
            "workflow_invalid",
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
    controller = _controller(recorder, deployed)
    url = f"{controller}/v1/workflow-groups/{deployed.workflow_group_id}"
    auth = controller_headers(recorder, deployed.dir)
    workflow = _status(recorder, url, auth)["endpoint"]["routes"][0]["workflow"]
    workflow_url = f"{url}/workflows/{workflow}"
    before = http(recorder, "GET", workflow_url, headers=auth).json()["fingerprints"]
    env = deployed.dir / ".env"
    body = {
        "name": deployed.dir.name,
        "config": (deployed.dir / "workflow_group.yaml").read_text("utf-8"),
        "env": env.read_text("utf-8") if env.is_file() else None,
    }
    http(recorder, "PUT", url, json=body, headers=auth)
    # Built by the CLI's own code, in its environment, so it is the upload a sync sends.
    archive = tmp_path / "workflow.tar.gz"
    cli_python(
        recorder,
        deployed.dir,
        "import shutil; from canyonos.sync import workflow_archive; "
        f"shutil.copyfileobj(workflow_archive({str(deployed.workflow_dir)!r}), "
        f"open({str(archive)!r}, 'wb'))",
    )
    upload = http(
        recorder,
        "PUT",
        workflow_url,
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
    after = http(recorder, "GET", workflow_url, headers=auth).json()["fingerprints"]
    assert after == before, (before, after)
