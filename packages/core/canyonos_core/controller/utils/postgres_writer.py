# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Shapes spans, metric samples and logs into records of the dashboard's Postgres tables
and writes them there.

The dashboard is optional, so a write never raises: a database that cannot be reached
is reported once and tried again later.
"""

import logging
import os
import threading
import time

import psycopg
from psycopg.types.json import Jsonb

from canyonos_core.schema.otel_metrics import (
    AGENT_GAUGES,
    AGENT_SUMS,
    MACHINE_GAUGES,
    SCOPE_NAME,
)

logger = logging.getLogger(__name__)

# The local dashboard's Postgres, by its container name on the workflow group's network.
DASHBOARD_DATABASE_URL = os.environ.get(
    "CANYONOS_DASHBOARD_DATABASE_URL",
    "postgresql://canyonos:canyonos@canyonos-dashboard-db:5432/canyonos",
)
# How long a database that did not answer is left alone before the next attempt.
RETRY_SECONDS = 30
ROLLUP_NANOS = 300 * 1_000_000_000

# Columns of a span row that are not attributes.
_SPAN_FIELDS = frozenset(
    {
        "span_id",
        "parent_span_id",
        "trace_id",
        "name",
        "start_time_unix_nano",
        "end_time_unix_nano",
        "status_code",
        "status_message",
        "exception.type",
    }
)


def _insert(table, columns):
    """SQL inserting a JSON array of records, given as the one parameter, into `table`."""
    names = ", ".join(columns)
    typed = ", ".join(f"{name} {kind}" for name, kind in columns.items())
    return (
        f"INSERT INTO {table} ({names}) "
        f"SELECT {names} FROM jsonb_to_recordset(%s) AS record({typed})"
    )


_INSERT_SPANS = (
    _insert(
        "otel_spans",
        {
            "span_id": "text",
            "trace_id": "text",
            "parent_span_id": "text",
            "name": "text",
            "kind": "text",
            "start_time_unix_nano": "bigint",
            "end_time_unix_nano": "bigint",
            "status_code": "text",
            "status_message": "text",
            "attributes": "jsonb",
            "events": "jsonb",
            "input": "text",
            "output": "text",
        },
    )
    + " ON CONFLICT (span_id) DO NOTHING"
)

_INSERT_LOGS = (
    _insert(
        "otel_logs",
        {
            "log_id": "text",
            "service_name": "text",
            "resource_attributes": "jsonb",
            "time_unix_nano": "bigint",
            "observed_time_unix_nano": "bigint",
            "severity_number": "integer",
            "severity_text": "text",
            "body": "text",
            "trace_id": "text",
            "span_id": "text",
            "attributes": "jsonb",
        },
    )
    # A log read before its call finished has no service name yet; a later read fills it in.
    + " ON CONFLICT (log_id) DO UPDATE SET service_name = excluded.service_name,"
    " resource_attributes = excluded.resource_attributes"
    " WHERE otel_logs.service_name IS NULL AND excluded.service_name IS NOT NULL"
)

_METRIC_COLUMNS = {
    "service_name": "text",
    "resource_attributes": "jsonb",
    "scope_name": "text",
    "metric_name": "text",
    "metric_unit": "text",
    "metric_type": "text",
    "time_unix_nano": "bigint",
    "value": "double precision",
    "data_point_attributes": "jsonb",
}

_INSERT_METRICS = _insert("otel_metrics", _METRIC_COLUMNS)

_typed_metric_columns = ", ".join(
    f"{name} {kind}" for name, kind in _METRIC_COLUMNS.items()
)
_UPSERT_ROLLUPS = f"""
    INSERT INTO otel_metric_rollups AS r (
        metric_name, metric_type, metric_unit, service_name, resource_attributes,
        data_point_attributes, bucket_start_unix_nano, sum, count, min, max, last_value,
        last_time_unix_nano
    )
    SELECT metric_name, metric_type, metric_unit, service_name, resource_attributes,
        data_point_attributes, time_unix_nano - time_unix_nano %% {ROLLUP_NANOS},
        sum(value), count(*), min(value), max(value),
        (array_agg(value ORDER BY time_unix_nano DESC))[1], max(time_unix_nano)
    FROM jsonb_to_recordset(%s) AS record({_typed_metric_columns})
    GROUP BY 1, 2, 3, 4, 5, 6, 7
    ON CONFLICT (metric_name, series_key, bucket_start_unix_nano) DO UPDATE SET
        sum = r.sum + excluded.sum,
        count = r.count + excluded.count,
        min = least(r.min, excluded.min),
        max = greatest(r.max, excluded.max),
        last_value = CASE
            WHEN excluded.last_time_unix_nano >= r.last_time_unix_nano
            THEN excluded.last_value ELSE r.last_value END,
        last_time_unix_nano = greatest(r.last_time_unix_nano, excluded.last_time_unix_nano)
"""

_lock = threading.Lock()
_connection = None
_reachable = True
_retry_at = 0
# Newest sample time shaped per machine or replica, so a re-read sample is not counted twice.
_last_sample_time = {}


def _write(records, *statements):
    """Run each SQL statement with the JSON array of `records` as its one parameter, all
    in one transaction on the shared connection, for one caller at a time. A database
    that does not answer is tried three times before the records are dropped."""
    global _connection, _reachable, _retry_at
    # Only Docker has this database; a Kubernetes dashboard gets telemetry over OTLP.
    if os.environ.get("CANYONOS_TARGET") == "kubernetes":
        return
    with _lock:
        if time.monotonic() < _retry_at:
            return
        for attempts_left in (2, 1, 0):
            try:
                if _connection is None or _connection.closed:
                    _connection = psycopg.connect(
                        DASHBOARD_DATABASE_URL, connect_timeout=2
                    )
                with _connection.transaction():
                    for sql in statements:
                        _connection.execute(sql, [Jsonb(records)])
            except psycopg.OperationalError as error:
                if attempts_left:
                    continue
                _retry_at = time.monotonic() + RETRY_SECONDS
                if _reachable:
                    logger.warning(
                        "The dashboard's database is not answering, so telemetry is "
                        "dropped until it does: %s",
                        error,
                    )
                _reachable = False
            except psycopg.Error as error:
                logger.warning(
                    "The dashboard's database refused telemetry, so it is dropped: %s",
                    error,
                )
            else:
                if not _reachable:
                    logger.info("The dashboard's database is answering again.")
                _reachable = True
            break


def span_record(row):
    """A finished span row, as the Global Controller builds it, as an `otel_spans` record."""
    failed = row["status_code"] == "ERROR"
    attributes = {
        key: value
        for key, value in row.items()
        if key not in _SPAN_FIELDS and value is not None
    }
    events = []
    if failed:
        exception = {"exception.message": row["status_message"] or ""}
        if row["exception.type"]:
            exception["exception.type"] = row["exception.type"]
        events.append(
            {
                "time_unix_nano": str(row["end_time_unix_nano"]),
                "name": "exception",
                "attributes": exception,
            }
        )
    return {
        "span_id": row["span_id"],
        "trace_id": row["trace_id"],
        "parent_span_id": row["parent_span_id"],
        "name": row["name"],
        "kind": "SPAN_KIND_INTERNAL",
        "start_time_unix_nano": row["start_time_unix_nano"],
        "end_time_unix_nano": row["end_time_unix_nano"],
        "status_code": f"STATUS_CODE_{row['status_code']}",
        "status_message": row["status_message"] if failed else None,
        "attributes": attributes,
        "events": events,
        "input": attributes.get("gen_ai.prompt"),
        "output": attributes.get("gen_ai.completion"),
    }


def log_record(row):
    """A log row, as the Global Controller builds it, as an `otel_logs` record."""
    resource = {"service.name": row["agent_id"]}
    if row["workflow_group_id"]:
        resource["canyonos.workflow_group.id"] = row["workflow_group_id"]
    if row["workflow_id"]:
        resource["canyonos.workflow.id"] = row["workflow_id"]
    time_unix_nano = round(float(row["observed_at"]) * 1e9)
    return {
        "log_id": row["log_id"],
        "service_name": row["agent_id"],
        "resource_attributes": resource,
        "time_unix_nano": time_unix_nano,
        "observed_time_unix_nano": time_unix_nano,
        "severity_number": row["severity_number"],
        "severity_text": row["severity_text"],
        "body": row["body"],
        "trace_id": row["trace_id"],
        "span_id": row["span_id"],
        "attributes": {
            key: value for key, value in row["attributes"].items() if value is not None
        },
    }


def _sample_records(sample):
    """One `otel_metrics` record per known metric in a machine or replica sample."""
    values = sample["metrics"]
    host = sample["host"]
    time_unix_nano = round(float(values["observed_at"]) * 1e9)
    if sample["kind"] == "agent":
        resource = {
            "service.name": sample["agent_name"],
            "service.instance.id": sample["agent_id"],
            "host.name": host,
            "canyonos.agent.port": str(sample["port"]),
        }
        point_attributes = {}
        metrics = [(name, unit, "gauge") for name, unit in AGENT_GAUGES.items()] + [
            (name, unit, "sum_cumulative") for name, unit in AGENT_SUMS.items()
        ]
    else:
        resource = {"service.name": f"canyonos-machine-{host}", "host.name": host}
        point_attributes = {"host.name": host}
        metrics = [(name, unit, "gauge") for name, unit in MACHINE_GAUGES.items()]
    if sample.get("workflow_group_id"):
        resource["canyonos.workflow_group.id"] = sample["workflow_group_id"]
    if sample.get("workflow_id"):
        resource["canyonos.workflow.id"] = sample["workflow_id"]

    records = []
    for name, unit, metric_type in metrics:
        try:
            value = float(values[name])
        except (KeyError, ValueError):
            continue
        records.append(
            {
                "service_name": resource["service.name"],
                "resource_attributes": resource,
                "scope_name": SCOPE_NAME,
                "metric_name": name,
                "metric_unit": unit,
                "metric_type": metric_type,
                "time_unix_nano": time_unix_nano,
                # A counter's series starts when its replica did; only the collector reads this.
                "start_time_unix_nano": round(
                    float(values.get("started_at") or values["observed_at"]) * 1e9
                ),
                "value": value,
                "data_point_attributes": point_attributes,
            }
        )
    return records


def metric_records(samples):
    """The `otel_metrics` records of machine and replica samples, as the Global Controller
    reads them from Redis. A sample no newer than the last one from its source is skipped."""
    records = []
    for sample in samples:
        source = (sample["kind"], sample.get("agent_id") or sample["host"])
        observed_at = float(sample["metrics"]["observed_at"])
        if observed_at <= _last_sample_time.get(source, 0):
            continue
        _last_sample_time[source] = observed_at
        records.extend(_sample_records(sample))
    return records


def write_spans(records):
    """Insert span records into `otel_spans`; one already stored is left as it is."""
    _write(records, _INSERT_SPANS)


def write_logs(records):
    """Insert log records into `otel_logs`; one already stored only gains a missing
    service name."""
    _write(records, _INSERT_LOGS)


def write_metrics(records):
    """Insert metric records into `otel_metrics` and add them to their five-minute
    rollups in the same transaction."""
    _write(records, _INSERT_METRICS, _UPSERT_ROLLUPS)
