# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Reads telemetry from a machine's Redis, stores it in the dashboard's Postgres and
forwards it to the collector for the external destinations.

Runs inside the Global Controller. ``send_telemetry`` stores what each poll reads, so the
dashboard is live. ``deliver_completed_requests`` stores a request once more when it
completes and forwards it then, so an external destination gets each request once.
"""

import collections
import json
import logging
import uuid

from canyonos_core.controller.utils import otel_collector, postgres_writer
from canyonos_core.controller.utils.log_entry import build_log_entry
from canyonos_core.llm_gateway import pricing


logger = logging.getLogger(__name__)

# Cost lookups can fail on every row of every poll, so each kind is reported once.
_cost_failures_logged = set()


def _log_cost_failure(kind, exc):
    """Report the first failure of each cost-lookup kind; suppress the rest."""
    if kind in _cost_failures_logged:
        return
    _cost_failures_logged.add(kind)
    logger.warning(
        "%s lookup failed; affected rows are recorded with a cost of 0. Further "
        "%s failures are suppressed for the life of this process: %s",
        kind,
        kind,
        exc,
        exc_info=True,
    )


def _normalize_json_text(value):
    """Return JSON text, encoding scalar strings that are not valid JSON."""
    if value is None:
        return None
    try:
        json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return json.dumps(value)
    return value


def _span_row(raw, redis_client, workflow_group_id):
    """One finished future row from Redis as a span row with typed values and its costs,
    or None when it lacks a future or request id. `redis_client` is read for the agent's hourly cost."""
    fid = raw.get("future_id")
    session_id = raw.get("request_id")
    if not fid or not session_id:
        missing = ", ".join(
            field
            for field, present in (
                ("future_id", fid),
                ("request_id", session_id),
            )
            if not present
        )
        logger.warning(
            "Dropping future row missing %s; it will never be exported "
            "(future_id=%r, request_id=%r)",
            missing,
            fid,
            session_id,
        )
        return None
    replica_id = raw.get("agent")
    workflow_id = raw.get("workflow_id")
    started_at = int(raw.get("created_at") or 0)
    finished_at = int(raw["finished_at"])
    execution_time_ms = round((finished_at - started_at) / 1e6) if started_at else None
    input_token_count = int(float(raw.get("gen_ai.usage.input_tokens") or 0))
    output_token_count = int(float(raw.get("gen_ai.usage.output_tokens") or 0))
    token_count = int(float(raw.get("token_count") or 0))
    cached_tokens = int(float(raw.get("gen_ai.usage.cache_read.input_tokens") or 0))
    cache_write_tokens = int(float(raw.get("input_cache_write_tokens") or 0))
    service = raw.get("service")
    method = raw.get("method")
    name = raw.get("name") or ".".join(part for part in (service, method) if part)
    result = raw.get("result")

    # Cost lookups can fail independently of the telemetry itself (e.g.
    # a malformed llm_prices.json) -- don't let that drop the whole row,
    # just cost it at 0.
    try:
        token_cost = pricing.compute_token_cost(
            raw.get("gen_ai.request.model"),
            input_token_count,
            output_token_count,
            cached_tokens,
            cache_write_tokens,
            prefix=raw.get("price_prefix"),
        )
    except Exception as e:
        _log_cost_failure("Token cost", e)
        token_cost = 0.0
    try:
        hourly_cost = (
            redis_client.get(f"agent:{replica_id}:hourly_cost")
            if redis_client is not None and replica_id
            else None
        )
        server_cost = float(hourly_cost or 0) * (finished_at - started_at) / 3600e9
    except Exception as e:
        _log_cost_failure("Server cost", e)
        server_cost = 0.0

    row = {
        "span_id": fid,
        "parent_span_id": raw.get("parent") or None,
        "trace_id": session_id,
        "canyonos.workflow_group.id": workflow_group_id,
        "canyonos.workflow.id": workflow_id,
        # The agent's id: one per agent name in its workflow, whatever replica ran.
        "gen_ai.agent.id": str(uuid.uuid5(uuid.UUID(workflow_id), service))
        if workflow_id and service
        else None,
        "canyonos.replica.id": replica_id,
        "gen_ai.request.model": raw.get("gen_ai.request.model"),
        "prompt_name": raw.get("prompt_name"),
        "prompt_version": raw.get("prompt_version"),
        "cpu": float(raw.get("cpu_resource") or 0),
        "gpu": float(raw.get("gpu_resource") or 0),
        "start_time_unix_nano": started_at,
        "end_time_unix_nano": finished_at,
        "execution_time_ms": execution_time_ms,
        "queue_time_ms": (
            round(float(raw["queue_time"]) * 1000) if raw.get("queue_time") else None
        ),
        "gen_ai.usage.input_tokens": input_token_count,
        "gen_ai.usage.output_tokens": output_token_count,
        "token_count": token_count,
        "error_count": int(raw.get("error_count") or 0),
        "status_code": "ERROR" if int(raw.get("failed") or 0) else "UNSET",
        "server_cost": server_cost,
        "token_cost": token_cost,
        "gen_ai.usage.cost": server_cost + token_cost,
        "gen_ai.usage.cache_read.input_tokens": cached_tokens,
        "cache_hit_ratio": cached_tokens / token_count if token_count else 0.0,
        "exception.type": raw.get("error_name"),
        "status_message": raw.get("error"),
        "name": name or replica_id or "unknown_agent",
        "gen_ai.prompt": _normalize_json_text(raw.get("args")),
        "gen_ai.completion": _normalize_json_text(result),
    }
    return row


def _log_rows(rows, workflow_group_id):
    """One log row per entry in each future row's `logs` field. `log_id` is
    `{future_id}:{index}`, so a future read again yields the same ids."""
    log_rows = []
    for raw in rows:
        fid = raw.get("future_id")
        logs_json = raw.get("logs")
        if not fid or not logs_json:
            continue
        try:
            entries = json.loads(logs_json)
        except (json.JSONDecodeError, TypeError):
            logger.warning("Dropping unparseable logs field for future %s", fid)
            continue
        for index, entry in enumerate(entries):
            if not isinstance(entry, dict):
                continue
            log_rows.append(
                _log_params(
                    entry,
                    f"{fid}:{index}",
                    fid,
                    raw.get("request_id"),
                    workflow_group_id,
                    raw.get("workflow_id"),
                    raw.get("agent"),
                )
            )
    return log_rows


def _log_params(
    entry, log_id, future_id, session_id, workflow_group_id, workflow_id, replica_id
):
    """One OTel-shaped log entry as a log row."""
    return {
        "log_id": log_id,
        "span_id": future_id,
        "trace_id": session_id,
        "workflow_group_id": workflow_group_id,
        "workflow_id": workflow_id,
        "replica_id": replica_id,
        "observed_at": entry.get("ObservedTimestamp") or entry.get("Timestamp"),
        "severity_number": entry.get("SeverityNumber"),
        "severity_text": entry.get("SeverityText"),
        "body": entry.get("Body"),
        "attributes": entry.get("Attributes") or {},
    }


class ProcessLogHandler(logging.Handler):
    """Collects every INFO-and-above record of this process as log rows under one source.

    For the Global Controller, which runs no futures: its logs reach the dashboard under
    `source_name` instead of a future's `logs` field. Taking WARNING and above here cannot
    double-record a failure, since `build_failure_entry` only ever writes to futures.
    """

    def __init__(self, source_name, workflow_group_id=None):
        super().__init__(level=logging.INFO)
        self._source_name = source_name
        self._workflow_group_id = workflow_group_id
        self._rows = collections.deque()

    def emit(self, record):
        """Keep the record as a log row; a failure is reported, never raised."""
        try:
            entry = build_log_entry(record, agent_name=self._source_name)
            self._rows.append(
                _log_params(
                    entry,
                    uuid.uuid4().hex,
                    None,
                    None,
                    self._workflow_group_id,
                    None,
                    self._source_name,
                )
            )
        except Exception:
            self.handleError(record)

    def store(self):
        """Store the collected rows in the dashboard's Postgres and forward them to the
        external destinations."""
        records = [
            postgres_writer.log_record(self._rows.popleft())
            for _ in range(len(self._rows))
        ]
        postgres_writer.write_logs(records)
        otel_collector.send_logs(records)


def _pull_telemetry(redis_client, finished=None):
    """Scan a machine's Redis for per-execution future rows; each future's identity and
    execution metrics both live at future:{future_id}.

    `finished`, when given, is the set of futures already stored with `finished_at`
    from this Redis: they are not read again, and the set is kept to what is still in
    Redis. `finished_at` is written together with a call's outcome, success or failure.
    """
    rows = []
    present = set()
    for key in redis_client.scan_keys("future:*"):
        if key.endswith(":children") or key.endswith(":consumers"):
            continue
        future_id = key.split(":")[1]
        # A Redis scan can return the same key twice.
        if future_id in present:
            continue
        present.add(future_id)
        if finished is not None and future_id in finished:
            continue
        data = redis_client.hgetall(key)
        if data:
            data["future_id"] = data.get("id") or future_id
            rows.append(data)
    if finished is not None:
        finished &= present
    return rows


def _read_futures(redis_client, future_ids):
    """Rows for exactly these futures, from one Redis (missing ones skipped)."""
    rows = []
    for future_id in future_ids:
        data = redis_client.hgetall(f"future:{future_id}")
        if data:
            data["future_id"] = data.get("id") or future_id
            rows.append(data)
    return rows


def _records(rows, redis_client, workflow_group_id, workflow_ids):
    """The span and log records of these future rows, in the shape of the dashboard's
    tables: a span for each finished future, and every log. Each gets its agent's
    workflow_id from `workflow_ids`, by workflow name."""
    for row in rows:
        # A future's service is its agent, named `<workflow>.<agent>`.
        row["workflow_id"] = workflow_ids.get(row.get("service", "").partition(".")[0])
    spans = [
        postgres_writer.span_record(span)
        for raw in rows
        if raw.get("finished_at")
        and (span := _span_row(raw, redis_client, workflow_group_id))
    ]
    logs = [
        postgres_writer.log_record(row) for row in _log_rows(rows, workflow_group_id)
    ]
    return spans, logs


def store_metrics(samples):
    """Store machine and replica samples, as the Global Controller reads them from Redis,
    in the dashboard's Postgres and forward them to the external destinations."""
    records = postgres_writer.metric_records(samples)
    postgres_writer.write_metrics(records)
    otel_collector.send_metrics(records)


def send_telemetry(redis_client, workflow_group_id, workflow_ids, finished=None):
    """Pull per-execution future rows from Redis and store their spans and logs. The GC
    calls this once per poll for each machine's Redis, keeping `finished` (see
    _pull_telemetry) between polls. Returns the rows it read.
    """
    rows = _pull_telemetry(redis_client, finished)
    spans, logs = _records(rows, redis_client, workflow_group_id, workflow_ids)
    postgres_writer.write_spans(spans)
    postgres_writer.write_logs(logs)
    if finished is not None:
        finished.update(row["future_id"] for row in rows if row.get("finished_at"))
    return rows


def deliver_completed_requests(
    redis_clients, request_ids, workflow_group_id, workflow_ids
):
    """Store a final all-machine snapshot, forward each newly delivered request to the
    external destinations, and mark the requests safe to clean up.

    Completion is authoritative in ``request:completed``. The expected future set is
    the union across every machine, while terminal rows are collected from every machine. A
    marker is written to every machine only after the snapshot was stored and forwarded.

    Returns ``(delivered, gone)``: ``delivered`` requests have every expected future
    terminal and are now marked; ``gone`` requests have no futures left on any machine --
    already cleaned up and expired -- so they can leave ``request:completed``.
    """
    request_ids = set(request_ids)
    if not request_ids:
        return set(), set()

    def futures_of(requests):
        expected = {request_id: set() for request_id in requests}
        for redis_client in redis_clients:
            for request_id in requests:
                expected[request_id].update(
                    redis_client.smembers(f"request:{request_id}:futures")
                )
        return expected

    # Marked on any machine by an earlier cycle: delivered already, nothing to re-read;
    # only whether its futures are gone yet matters.
    marked = {
        request_id
        for request_id in request_ids
        if any(
            redis_client.get(f"telemetry:delivered:{request_id}")
            for redis_client in redis_clients
        )
    }
    pending = request_ids - marked

    # Only these requests' futures are read (not every future in Redis), from every
    # machine, and written before anything is judged.
    wanted = set().union(*futures_of(pending).values()) if pending else set()
    terminal_by_request = {request_id: set() for request_id in request_ids}
    spans, logs = {}, {}
    for redis_client in redis_clients:
        rows = _read_futures(redis_client, wanted)
        client_spans, client_logs = _records(
            rows, redis_client, workflow_group_id, workflow_ids
        )
        spans.update((record["span_id"], record) for record in client_spans)
        logs.update((record["log_id"], record) for record in client_logs)
        for row in rows:
            request_id = row.get("request_id")
            if request_id in pending and row.get("finished_at"):
                terminal_by_request[request_id].add(row["future_id"])
    postgres_writer.write_spans(list(spans.values()))
    postgres_writer.write_logs(list(logs.values()))
    # Read again after writing, so a future added meanwhile, unread, is still expected
    # and holds its request back.
    expected_by_request = futures_of(request_ids)

    gone = {
        request_id for request_id in request_ids if not expected_by_request[request_id]
    }
    delivered = {
        request_id
        for request_id in request_ids - gone
        if request_id in marked
        or expected_by_request[request_id] <= terminal_by_request[request_id]
    }
    newly_delivered = delivered - marked
    sent = otel_collector.send_spans(
        [span for span in spans.values() if span["trace_id"] in newly_delivered]
    ) and otel_collector.send_logs(
        [log for log in logs.values() if log["trace_id"] in newly_delivered]
    )
    if not sent:
        # Left unmarked, so the next cycle reads and forwards them again.
        delivered -= newly_delivered
    for redis_client in redis_clients:
        for request_id in delivered:
            # NX: never overwrite the marker, so the expiry cleanup gave it survives.
            redis_client.set(f"telemetry:delivered:{request_id}", "1", nx=True)
    return delivered, gone
