# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
What the CLI usage end-to-end tests run against: the real usage API server from
`packages/cli-usage-api` on a free loopback port, backed by a disposable moto server
container standing in for Firehose and S3, and test-owned clients that read the stored
events and feedback straight from the bucket.
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
from pathlib import Path

import boto3


REPO_ROOT = Path(__file__).resolve().parents[2]
API_DIR = REPO_ROOT / "packages" / "cli-usage-api"
STREAM = "canyonos-cli-usage-events-cli-e2e"
BUCKET = "canyonos-cli-usage-cli-e2e"


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


class Store:
    """Direct access to the moto server's bucket and Firehose stream, owned by the tests."""

    def __init__(self, endpoint):
        self.endpoint = endpoint
        options = {
            "endpoint_url": endpoint,
            "region_name": "us-east-1",
            "aws_access_key_id": "local",
            "aws_secret_access_key": "local",
        }
        self.s3 = boto3.client("s3", **options)
        self.firehose = boto3.client("firehose", **options)

    def create(self):
        """Create the bucket and the usage events stream that writes to it."""
        self.s3.create_bucket(Bucket=BUCKET)
        self.firehose.create_delivery_stream(
            DeliveryStreamName=STREAM,
            ExtendedS3DestinationConfiguration={
                "RoleARN": "arn:aws:iam::123456789012:role/canyonos-cli-usage-firehose",
                "BucketARN": f"arn:aws:s3:::{BUCKET}",
                "Prefix": "usage-events/",
            },
        )

    def _objects(self, prefix):
        pages = self.s3.get_paginator("list_objects_v2").paginate(
            Bucket=BUCKET, Prefix=prefix
        )
        for page in pages:
            for entry in page.get("Contents", []):
                body = self.s3.get_object(Bucket=BUCKET, Key=entry["Key"])["Body"]
                yield body.read().decode()

    def events_where(self, name, value):
        """Every stored usage event whose `name` field is `value`."""
        events = [
            json.loads(line)
            for text in self._objects("usage-events/")
            for line in text.splitlines()
        ]
        return [event for event in events if event.get(name) == value]

    def feedback_where(self, name, value):
        """Every stored feedback whose `name` field is `value`."""
        stored = [json.loads(text) for text in self._objects("feedback/")]
        return [item for item in stored if item.get(name) == value]


def _moto_image():
    compose = (API_DIR / "docker-compose.yml").read_text()
    match = re.search(r"^\s*image:\s*(\S+)$", compose, re.M)
    assert match, "packages/cli-usage-api/docker-compose.yml names no moto image"
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
    """The moto server container and the usage API server in front of it."""

    def __init__(self):
        self.container = f"canyonos-cli-usage-cli-e2e-{uuid.uuid4().hex[:8]}"
        self.moto_port = free_port()
        self.api_port = free_port()
        self.url = f"http://127.0.0.1:{self.api_port}"
        self.store = Store(f"http://127.0.0.1:{self.moto_port}")
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
                f"127.0.0.1:{self.moto_port}:5000",
                _moto_image(),
            ],
            check=True,
            capture_output=True,
        )
        self.wait_for_store()
        self.store.create()
        self.server = subprocess.Popen(
            ["bun", "run", "src/server.ts"],
            cwd=API_DIR,
            env={
                "PATH": os.environ.get("PATH", ""),
                "HOME": os.environ.get("HOME", ""),
                "APP_ENV": "test",
                "CLI_USAGE_AWS_ENDPOINT": self.store.endpoint,
                "CLI_USAGE_STREAM_NAME": STREAM,
                "CLI_FEEDBACK_BUCKET_NAME": BUCKET,
                "CLI_USAGE_PORT": str(self.api_port),
            },
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
        )
        assert wait_until(lambda: _http_answers(self.url)), "usage API did not start"

    def wait_for_store(self):
        listed = wait_until(lambda: _http_answers(self.store.endpoint), timeout=60)
        assert listed, "the moto server did not start"

    def stop_store(self):
        subprocess.run(
            ["docker", "stop", self.container], check=True, capture_output=True
        )

    def start_store(self):
        """Start the moto server again. It keeps its data in memory, so it comes back
        empty and the bucket and stream are created again."""
        subprocess.run(
            ["docker", "start", self.container], check=True, capture_output=True
        )
        self.wait_for_store()
        self.store.create()

    def remove(self):
        if self.server is not None:
            self.server.terminate()
            try:
                self.server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.server.kill()
        subprocess.run(["docker", "rm", "-f", self.container], capture_output=True)
