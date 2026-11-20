# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Runs an OpenTelemetry Collector that forwards telemetry to the external
`otel.destinations`, and hands it the records the Global Controller newly stored."""

import logging
import os
import re
import tempfile

import requests
import yaml

from canyonos_core.schema.otel_destinations import normalize_destination

logger = logging.getLogger(__name__)

PROCESS_NAME = "otel_collector"
_BINARY = "otelcol-otlp"
_CONFIG_PATH = os.path.join(tempfile.gettempdir(), "canyonos-otelcol.yaml")
_RECEIVER = "127.0.0.1:4318"
_STATUS_CODES = {"STATUS_CODE_UNSET": 0, "STATUS_CODE_ERROR": 2}

# The config of the collector that is running; None when none runs.
_applied = None


def _config(destinations):
    """The collector config that receives OTLP on localhost and sends every signal to
    each destination."""
    exporters = {}
    for index, destination in enumerate(map(normalize_destination, destinations)):
        # The dashboard API cannot read the gzip bodies the collector sends by default.
        settings = {"endpoint": destination["endpoint"], "compression": "none"}
        if destination["headers"]:
            settings["headers"] = destination["headers"]
        if destination["timeout"]:
            settings["timeout"] = f"{destination['timeout']}s"
        kind = "otlp_http"
        if destination["protocol"] == "grpc":
            kind = "otlp_grpc"
            insecure = destination["insecure"]
            if insecure is None:
                insecure = destination["endpoint"].startswith("http://")
            settings["tls"] = {"insecure": insecure}
        # Collector component names take no spaces or symbols; the index keeps them unique.
        name = re.sub(r"[^\w.-]", "_", destination["name"])
        exporters[f"{kind}/{index}_{name}"] = settings
    return {
        "receivers": {"otlp": {"protocols": {"http": {"endpoint": _RECEIVER}}}},
        "exporters": exporters,
        "service": {
            "telemetry": {"metrics": {"level": "none"}},
            "pipelines": {
                signal: {"receivers": ["otlp"], "exporters": list(exporters)}
                for signal in ("traces", "metrics", "logs")
            },
        },
    }


def run(supervisor, destinations):
    """Run a collector that forwards to `destinations`, replacing the one already
    running unless it forwards to the same ones. With no destinations none runs."""
    global _applied
    config = _config(destinations) if destinations else None
    if config == _applied:
        return
    supervisor.stop(PROCESS_NAME)
    _applied = config
    if config is None:
        return
    # Headers can hold API keys, so only this user may read the file.
    descriptor = os.open(_CONFIG_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with open(descriptor, "w") as config_file:
        yaml.safe_dump(config, config_file)
    supervisor.register(PROCESS_NAME, [_BINARY, f"--config={_CONFIG_PATH}"])
    supervisor.start(PROCESS_NAME)


def _post(signal, body):
    """Send one OTLP JSON request to the collector, trying three times; a failure is
    logged, never raised. Returns whether the collector took it."""
    for _ in range(3):
        try:
            requests.post(
                f"http://{_RECEIVER}/v1/{signal}", json=body, timeout=2
            ).raise_for_status()
            return True
        except requests.RequestException as error:
            failure = error
    logger.warning(
        "Could not hand %s to the OpenTelemetry Collector: %s", signal, failure
    )
    return False


def _key_values(attributes):
    """A flat attribute mapping as OTLP key-value pairs."""
    pairs = []
    for key, value in attributes.items():
        if isinstance(value, int):
            typed = {"intValue": str(value)}
        elif isinstance(value, float):
            typed = {"doubleValue": value}
        else:
            typed = {"stringValue": value}
        pairs.append({"key": key, "value": typed})
    return pairs


def send_spans(records):
    """Forward newly stored `otel_spans` records to the external destinations. Returns
    False only when the collector did not take them."""
    if not (_applied and records):
        return True
    spans = []
    for record in records:
        span = {
            "traceId": record["trace_id"],
            "spanId": record["span_id"],
            "name": record["name"],
            "kind": 1,
            "startTimeUnixNano": str(record["start_time_unix_nano"]),
            "endTimeUnixNano": str(record["end_time_unix_nano"]),
            "attributes": _key_values(record["attributes"]),
            "events": [
                {
                    "timeUnixNano": event["time_unix_nano"],
                    "name": event["name"],
                    "attributes": _key_values(event["attributes"]),
                }
                for event in record["events"]
            ],
            "status": {"code": _STATUS_CODES[record["status_code"]]},
        }
        if record["parent_span_id"]:
            span["parentSpanId"] = record["parent_span_id"]
        if record["status_message"]:
            span["status"]["message"] = record["status_message"]
        spans.append(span)
    return _post("traces", {"resourceSpans": [{"scopeSpans": [{"spans": spans}]}]})


def send_metrics(records):
    """Forward newly stored `otel_metrics` records to the external destinations."""
    if not (_applied and records):
        return
    resource_metrics = []
    for record in records:
        point = {
            "timeUnixNano": str(record["time_unix_nano"]),
            "asDouble": record["value"],
            "attributes": _key_values(record["data_point_attributes"]),
        }
        metric = {"name": record["metric_name"], "unit": record["metric_unit"]}
        if record["metric_type"] == "gauge":
            metric["gauge"] = {"dataPoints": [point]}
        else:
            point["startTimeUnixNano"] = str(record["start_time_unix_nano"])
            metric["sum"] = {
                "aggregationTemporality": 2,
                "isMonotonic": True,
                "dataPoints": [point],
            }
        resource_metrics.append(
            {
                "resource": {"attributes": _key_values(record["resource_attributes"])},
                "scopeMetrics": [
                    {"scope": {"name": record["scope_name"]}, "metrics": [metric]}
                ],
            }
        )
    _post("metrics", {"resourceMetrics": resource_metrics})


def send_logs(records):
    """Forward newly stored `otel_logs` records to the external destinations. Returns
    False only when the collector did not take them."""
    if not (_applied and records):
        return True
    resource_logs = []
    for record in records:
        log = {
            "timeUnixNano": str(record["time_unix_nano"]),
            "observedTimeUnixNano": str(record["observed_time_unix_nano"]),
            "severityNumber": record["severity_number"],
            "severityText": record["severity_text"],
            "body": {"stringValue": record["body"]},
            # The id lets the dashboard API store a log that is sent again only once.
            "attributes": _key_values(
                {**record["attributes"], "canyonos.log.id": record["log_id"]}
            ),
        }
        if record["trace_id"]:
            log["traceId"] = record["trace_id"]
        if record["span_id"]:
            log["spanId"] = record["span_id"]
        resource_logs.append(
            {
                "resource": {"attributes": _key_values(record["resource_attributes"])},
                "scopeLogs": [{"logRecords": [log]}],
            }
        )
    return _post("logs", {"resourceLogs": resource_logs})
