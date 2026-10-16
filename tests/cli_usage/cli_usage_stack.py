# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
What the CLI usage end-to-end tests run against: the real usage API server from
`packages/cli-usage-api` on a free loopback port, backed by a disposable DynamoDB Local
container, and a test-owned client that reads the stored events straight from the table.
"""

import json
import os
import re
import socket
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
API_DIR = REPO_ROOT / "packages" / "cli-usage-api"
TABLE = "canyonos-cli-usage-events-cli-e2e"


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def wait_until(condition, timeout=30.0, interval=0.1):
    """Poll `condition` until it returns something truthy and return that, or None
    once `timeout` seconds have passed."""
    deadline = time.monotonic() + timeout
    while True:
        result = condition()
        if result or time.monotonic() > deadline:
            return result
        time.sleep(interval)


class DynamoTable:
    """Direct reads of the usage events table in DynamoDB Local, owned by the tests.
    DynamoDB Local checks that a request is signed but not the signature itself."""

    def __init__(self, endpoint, name):
        self.endpoint = endpoint
        self.name = name

    def call(self, operation, payload):
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        request = urllib.request.Request(
            self.endpoint,
            data=json.dumps(payload).encode(),
            method="POST",
            headers={
                "Content-Type": "application/x-amz-json-1.0",
                "X-Amz-Target": f"DynamoDB_20120810.{operation}",
                "X-Amz-Date": stamp,
                "Authorization": (
                    f"AWS4-HMAC-SHA256 Credential=local/{stamp[:8]}/us-east-1/"
                    "dynamodb/aws4_request, SignedHeaders=host;x-amz-date, "
                    f"Signature={'0' * 64}"
                ),
            },
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read())

    def create(self):
        self.call(
            "CreateTable",
            {
                "TableName": self.name,
                "BillingMode": "PAY_PER_REQUEST",
                "AttributeDefinitions": [
                    {"AttributeName": "event_id", "AttributeType": "S"}
                ],
                "KeySchema": [{"AttributeName": "event_id", "KeyType": "HASH"}],
            },
        )

    def items_for(self, installation_id):
        """Every stored event of one installation, as DynamoDB returns them."""
        items = []
        start = None
        while True:
            payload = {
                "TableName": self.name,
                "ConsistentRead": True,
                "FilterExpression": "installation_id = :id",
                "ExpressionAttributeValues": {":id": {"S": installation_id}},
            }
            if start is not None:
                payload["ExclusiveStartKey"] = start
            page = self.call("Scan", payload)
            items.extend(page.get("Items", []))
            start = page.get("LastEvaluatedKey")
            if start is None:
                return items

    def item(self, event_id):
        """The stored event with this id, or None."""
        return self.call(
            "GetItem",
            {
                "TableName": self.name,
                "Key": {"event_id": {"S": event_id}},
                "ConsistentRead": True,
            },
        ).get("Item")


def _dynamodb_image():
    compose = (API_DIR / "docker-compose.yml").read_text()
    match = re.search(r"^\s*image:\s*(\S+)$", compose, re.M)
    assert match, "packages/cli-usage-api/docker-compose.yml names no DynamoDB image"
    return match.group(1)


def _answers(probe):
    try:
        probe()
    except (OSError, urllib.error.URLError):
        return False
    return True


def _http_answers(url):
    def probe():
        try:
            urllib.request.urlopen(url, timeout=2)
        except urllib.error.HTTPError:
            pass

    return _answers(probe)


class UsageStack:
    """The DynamoDB Local container and the usage API server in front of it."""

    def __init__(self):
        self.container = f"canyonos-cli-usage-cli-e2e-{uuid.uuid4().hex[:8]}"
        self.dynamo_port = free_port()
        self.api_port = free_port()
        self.url = f"http://127.0.0.1:{self.api_port}"
        self.table = DynamoTable(f"http://127.0.0.1:{self.dynamo_port}", TABLE)
        self.server = None

    def start(self):
        subprocess.run(
            [
                "docker",
                "run",
                "-d",
                "--name",
                self.container,
                "-p",
                f"127.0.0.1:{self.dynamo_port}:8000",
                _dynamodb_image(),
                "-jar",
                "DynamoDBLocal.jar",
                "-sharedDb",
                "-dbPath",
                "/home/dynamodblocal",
            ],
            check=True,
            capture_output=True,
        )
        self.wait_for_dynamo()
        self.table.create()
        self.server = subprocess.Popen(
            ["bun", "run", "src/server.ts"],
            cwd=API_DIR,
            env={
                "PATH": os.environ.get("PATH", ""),
                "HOME": os.environ.get("HOME", ""),
                "APP_ENV": "test",
                "CLI_USAGE_DYNAMODB_ENDPOINT": self.table.endpoint,
                "CLI_USAGE_TABLE_NAME": TABLE,
                "CLI_USAGE_PORT": str(self.api_port),
            },
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
        )
        assert wait_until(lambda: _http_answers(self.url)), "usage API did not start"

    def wait_for_dynamo(self):
        listed = wait_until(
            lambda: _answers(lambda: self.table.call("ListTables", {})), timeout=60
        )
        assert listed, "DynamoDB Local did not start"

    def stop_dynamo(self):
        subprocess.run(
            ["docker", "stop", self.container], check=True, capture_output=True
        )

    def start_dynamo(self):
        subprocess.run(
            ["docker", "start", self.container], check=True, capture_output=True
        )
        self.wait_for_dynamo()

    def remove(self):
        if self.server is not None:
            self.server.terminate()
            try:
                self.server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.server.kill()
        subprocess.run(["docker", "rm", "-f", self.container], capture_output=True)
