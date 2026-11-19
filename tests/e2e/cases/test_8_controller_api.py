# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The CanyonOS API's `/v1/workflow-groups` routes, which run the workflow group's
Global Controller, as the CLI calls them, with this machine's control key: its OpenAPI
spec at `/docs/json` lists every route, each answer has the fields and types the spec
gives it, each error carries its `workflow_groups.*` code (`validation_error` for a
request it can't read), a call without the control key is refused, a rejected upload
changes nothing, and uploading what already runs keeps the workflow's fingerprints and
applies as nothing."""

import io
import tarfile
import uuid

from ..harness import canyonos, cli_python, controller_headers, http, poll

PREFIX = "/v1/workflow-groups"
ROUTES = {
    (PREFIX, "get"),
    (f"{PREFIX}/{{workflow_group_id}}", "put"),
    (f"{PREFIX}/{{workflow_group_id}}", "get"),
    (f"{PREFIX}/{{workflow_group_id}}", "delete"),
    (f"{PREFIX}/{{workflow_group_id}}/workflows/{{name}}", "put"),
    (f"{PREFIX}/{{workflow_group_id}}/workflows/{{name}}", "delete"),
    (f"{PREFIX}/{{workflow_group_id}}/logs/controller", "get"),
    (f"{PREFIX}/{{workflow_group_id}}/logs/agents/{{name}}", "get"),
    (f"{PREFIX}/{{workflow_group_id}}/health", "get"),
    (f"{PREFIX}/{{workflow_group_id}}/workflows", "get"),
    (f"{PREFIX}/{{workflow_group_id}}/workflows/{{name}}", "get"),
    (f"{PREFIX}/{{workflow_group_id}}/dashboard", "put"),
}
GZIP = {"Content-Type": "application/gzip"}
JSON_TYPES = {
    "object": dict,
    "array": list,
    "string": str,
    "boolean": bool,
    "integer": int,
    "number": (int, float),
}


def _api(recorder, deployed):
    """Where the CanyonOS API answers, as `canyonos status --json` reports it."""
    return canyonos(recorder, ["status", "--json"], cwd=deployed.dir).json()[
        "controller_url"
    ]


def _spec(recorder, url):
    return http(recorder, "GET", f"{url}/docs/json").json()


def _resolved(spec, schema):
    """`schema` with its `$ref`s to the spec's components followed."""
    while "$ref" in schema:
        schema = spec["components"]["schemas"][schema["$ref"].rsplit("/", 1)[1]]
    return schema


def _mismatch(spec, value, schema, where="body"):
    """Why `value` does not fit `schema`: a field it lacks, a field it requires, or a
    type it has not; None when it fits."""
    schema = _resolved(spec, schema)
    if value is None and schema.get("nullable"):
        return None
    for key in ("anyOf", "oneOf"):
        if key in schema:
            if any(_mismatch(spec, value, one, where) is None for one in schema[key]):
                return None
            return f"{where}: {value!r} fits none of {schema[key]}"
    for one in schema.get("allOf", ()):
        if (why := _mismatch(spec, value, one, where)) is not None:
            return why
    if "enum" in schema and value not in schema["enum"]:
        return f"{where}: {value!r} is not one of {schema['enum']}"
    kinds = schema.get("type")
    if kinds is None:
        return None
    kinds = kinds if isinstance(kinds, list) else [kinds]
    if value is None:
        return None if "null" in kinds else f"{where}: null is not {kinds}"
    if not any(
        isinstance(value, JSON_TYPES[kind])
        and not (isinstance(value, bool) and kind in ("integer", "number"))
        for kind in kinds
        if kind in JSON_TYPES
    ):
        return f"{where}: {value!r} is not {kinds}"
    if isinstance(value, dict):
        properties = schema.get("properties")
        if properties is not None:
            extra = set(value) - set(properties)
            if extra:
                return f"{where}: fields the spec lacks: {sorted(extra)}"
            for name, field in properties.items():
                if name in value:
                    why = _mismatch(spec, value[name], field, f"{where}.{name}")
                    if why is not None:
                        return why
        missing = set(schema.get("required", ())) - set(value)
        if missing:
            return f"{where}: missing {sorted(missing)}"
        extra_schema = schema.get("additionalProperties")
        if isinstance(extra_schema, dict):
            for name, item in value.items():
                why = _mismatch(spec, item, extra_schema, f"{where}.{name}")
                if why is not None:
                    return why
    if isinstance(value, list) and "items" in schema:
        for index, item in enumerate(value):
            why = _mismatch(spec, item, schema["items"], f"{where}[{index}]")
            if why is not None:
                return why
    return None


def _answer(spec, call, path, method):
    """`call`'s JSON body, checked against the schema the spec gives route `path`'s
    `method` for the status it answered with."""
    body = call.json()
    responses = spec["paths"][path][method]["responses"]
    answer = responses.get(str(call.code)) or responses["default"]
    content = answer["content"]
    schema = (content.get("application/json") or next(iter(content.values())))["schema"]
    why = _mismatch(spec, body, schema)
    assert why is None, (why, call.output)
    return body


def _status(recorder, spec, url, workflow_group_id, auth):
    call = http(recorder, "GET", f"{url}{PREFIX}/{workflow_group_id}", headers=auth)
    return _answer(spec, call, f"{PREFIX}/{{workflow_group_id}}", "get")


def test_spec_lists_every_route(recorder, deployed):
    url = _api(recorder, deployed)
    spec = _spec(recorder, url)
    routes = {
        (path, method)
        for path, item in spec["paths"].items()
        if path.startswith(PREFIX)
        for method in item
    }
    assert routes == ROUTES, sorted(routes)
    auth = controller_headers(recorder, deployed.dir)
    status = _status(recorder, spec, url, deployed.workflow_group_id, auth)
    assert status["running"] is True, status


def test_reads_match_the_spec(recorder, deployed):
    url = _api(recorder, deployed)
    spec = _spec(recorder, url)
    auth = controller_headers(recorder, deployed.dir)
    workflow_groups = _answer(
        spec, http(recorder, "GET", f"{url}{PREFIX}", headers=auth), PREFIX, "get"
    )
    held = {"workflow_group_id": deployed.workflow_group_id, "name": deployed.dir.name}
    assert held in workflow_groups["workflow_groups"], workflow_groups
    status = _status(recorder, spec, url, deployed.workflow_group_id, auth)
    assert status["phase"] == "up", status
    assert status["applied_generation"] == status["generation"], status
    assert status["last_apply"]["ok"], status
    assert status["name"] == deployed.dir.name, status
    config = (deployed.dir / "workflow_group.yaml").read_text()
    assert status["config"] == config, status
    group = f"{PREFIX}/{{workflow_group_id}}"
    base = f"{url}{PREFIX}/{deployed.workflow_group_id}"
    workflow = status["endpoint"]["routes"][0]["workflow"]
    listed = _answer(
        spec,
        http(recorder, "GET", f"{base}/workflows", headers=auth),
        f"{group}/workflows",
        "get",
    )["workflows"]
    one = _answer(
        spec,
        http(recorder, "GET", f"{base}/workflows/{workflow}", headers=auth),
        f"{group}/workflows/{{name}}",
        "get",
    )
    assert one in listed, (one, listed)
    health = _answer(
        spec,
        http(recorder, "GET", f"{base}/health", headers=auth),
        f"{group}/health",
        "get",
    )
    assert health["ok"], health
    agent = deployed.agents[0]
    logs = _answer(
        spec,
        http(recorder, "GET", f"{base}/logs/agents/{agent}?tail=5", headers=auth),
        f"{group}/logs/agents/{{name}}",
        "get",
    )
    assert logs["logs"], logs
    log = http(recorder, "GET", f"{base}/logs/controller?tail=5", headers=auth)
    assert log.headers["content-type"].startswith("text/plain"), log.headers
    assert 0 < len(log.output.splitlines()) <= 5, log.output


def test_errors_carry_their_code(recorder, deployed):
    url = _api(recorder, deployed)
    spec = _spec(recorder, url)
    auth = controller_headers(recorder, deployed.dir)
    group = f"{PREFIX}/{{workflow_group_id}}"
    prefix = f"{PREFIX}/{deployed.workflow_group_id}"
    status = _status(recorder, spec, url, deployed.workflow_group_id, auth)
    workflow = status["endpoint"]["routes"][0]["workflow"]
    before = status["generation"]
    broken = io.BytesIO()
    with tarfile.open(fileobj=broken, mode="w:gz") as archive:
        config = b"agents: 3\n"
        info = tarfile.TarInfo("config/workflow_config.yaml")
        info.size = len(config)
        archive.addfile(info, io.BytesIO(config))
    unknown = str(uuid.uuid4())
    body = {"name": "x", "config": "workflow_group_id: x\n", "env": None}
    rejected = [
        # path in the spec, method, URL path, request, status, error
        (group, "GET", prefix, {"headers": {}}, 401, "auth.missing_key"),
        (
            group,
            "GET",
            f"{prefix}",
            {"headers": {"Authorization": "Bearer not-the-control-key"}},
            401,
            "auth.invalid_key",
        ),
        (
            group,
            "GET",
            f"{PREFIX}/{unknown}",
            {},
            404,
            "workflow_groups.unknown_workflow_group",
        ),
        (
            f"{group}/logs/controller",
            "GET",
            f"{prefix}/logs/controller?tail=lots",
            {},
            422,
            "validation_error",
        ),
        (
            f"{group}/logs/agents/{{name}}",
            "GET",
            f"{prefix}/logs/agents/NoSuchAgent",
            {},
            404,
            "workflow_groups.unknown_agent",
        ),
        (group, "PUT", prefix, {"json": {"name": "x"}}, 422, "validation_error"),
        (
            group,
            "PUT",
            f"{PREFIX}/{unknown}",
            {"json": body},
            409,
            "workflow_groups.controller_missing",
        ),
        (
            f"{group}/workflows/{{name}}",
            "GET",
            f"{prefix}/workflows/no-such",
            {},
            404,
            "workflow_groups.unknown_workflow",
        ),
        (
            f"{group}/workflows/{{name}}",
            "DELETE",
            f"{prefix}/workflows/no-such",
            {},
            404,
            "workflow_groups.unknown_workflow",
        ),
        (
            f"{group}/workflows/{{name}}",
            "PUT",
            f"{prefix}/workflows/{workflow}",
            {"data": b"not a tar", "headers": {**GZIP, **auth}},
            400,
            "workflow_groups.bad_archive",
        ),
        (
            f"{group}/workflows/{{name}}",
            "PUT",
            f"{prefix}/workflows/{workflow}",
            {"data": broken.getvalue(), "headers": {**GZIP, **auth}},
            400,
            "workflow_groups.workflow_invalid",
        ),
    ]
    for path, method, target, request, code, error in rejected:
        call = http(
            recorder,
            method,
            f"{url}{target}",
            check=False,
            **{"headers": auth, **request},
        )
        assert call.code == code, call.output
        if code == 401:
            # Refused before the route is matched, so its answer is the API's own.
            answer = call.json()
            assert set(answer) >= {"error", "message"}, call.output
        else:
            answer = _answer(spec, call, path, method.lower())
        assert answer["error"] == error, call.output
        assert "access-control-allow-origin" not in call.headers, call.headers
    assert call.json()["findings"], call.output
    after = _status(recorder, spec, url, deployed.workflow_group_id, auth)
    assert after["generation"] == before and after["phase"] == "up", after


def test_uploading_what_runs_changes_nothing(recorder, deployed, tmp_path):
    api = _api(recorder, deployed)
    spec = _spec(recorder, api)
    url = f"{api}{PREFIX}/{deployed.workflow_group_id}"
    auth = controller_headers(recorder, deployed.dir)
    status = _status(recorder, spec, api, deployed.workflow_group_id, auth)
    workflow = status["endpoint"]["routes"][0]["workflow"]
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
    generation = _answer(
        spec, upload, f"{PREFIX}/{{workflow_group_id}}/workflows/{{name}}", "put"
    )["generation"]

    def applied():
        status = _status(recorder, spec, api, deployed.workflow_group_id, auth)
        return status if status["applied_generation"] >= generation else None

    status = poll(applied, timeout=60, interval=1, what=f"generation {generation}")
    assert status["last_apply"]["action"] == "none", status["last_apply"]
    assert status["phase"] == "up", status
    after = http(recorder, "GET", workflow_url, headers=auth).json()["fingerprints"]
    assert after == before, (before, after)
