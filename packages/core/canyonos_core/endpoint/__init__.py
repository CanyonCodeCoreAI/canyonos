# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The CanyonOS endpoint: serves the deployment's agent methods over HTTP.

`POST /<project>/<agent>/<method>` queues a root call to one of its routes and answers
with its request id;
`POST /answer/<request_id>` answers that request's oldest waiting question; and
`GET /status/<request_id>` reports the call's result once it is done, or the
question it is waiting on.
"""

import json
import os
from urllib.parse import urlsplit

from canyonos_core.schema import qualified_name

# The HTTP port inside the endpoint's container, and the default `api_port` it is
# published on.
ENDPOINT_PORT = 8080

# CPUs the endpoint's container gets; it runs one gunicorn worker per CPU.
ENDPOINT_CPUS = 2

# The name of the endpoint's replica spec; agents are named `<project>.<agent>`, so
# none can take it.
ENDPOINT_AGENT_NAME = "endpoint"

# The dashboard API reads the endpoint's address here.
ADDRESS_KEY = "endpoint:address"

# The Global Controller writes the project_id here, the audience the endpoint
# accepts tokens for.
IDENTITY_KEY = "controller:identity"


def route_path(route):
    """The path a route is served at: `/<project>/<agent>/<method>`."""
    return f"/{route['project']}/{route['agent']}/{route['method']}"


def endpoint_routes(config):
    """Return the `endpoint.routes` of a deployment's raw config, each with its
    method's argument names from its `functions:` entry, as the endpoint container
    serves them."""
    functions = {
        (agent["name"], function["name"]): function
        for agent in config["agents"]
        for function in agent.get("functions") or []
    }
    routes = []
    for route in config["endpoint"]["routes"]:
        agent_name = qualified_name(route["project"], route["agent"])
        function = functions.get((agent_name, route["method"]), {})
        arguments = function.get("arguments") or []
        routes.append(
            {
                "project": route["project"],
                "agent": route["agent"],
                "method": route["method"],
                "arguments": [argument["name"] for argument in arguments],
            }
        )
    return routes


def endpoint_record(manifest, published_port):
    """Return where callers reach the endpoint of a validated manifest: its public host
    and port, and per route the project, agent and method it serves, that method's
    argument names from its `functions:` entry, and its URL. The Global Controller publishes
    it at ADDRESS_KEY.

    CANYONOS_ENDPOINT_URL, when set, is the endpoint's base URL (on Kubernetes the
    operator sets its Route, Ingress or in-cluster Service). Otherwise it is the
    `api_port` published on CANYONOS_PUBLIC_IP, or on 127.0.0.1; without one,
    `published_port`, the port the endpoint's container got."""
    endpoint = manifest.endpoint
    base_url = os.environ.get("CANYONOS_ENDPOINT_URL")
    if base_url:
        parts = urlsplit(base_url)
        public_host = parts.hostname
        api_port = parts.port or (443 if parts.scheme == "https" else 80)
        base_url = base_url.rstrip("/")
    else:
        public_host = os.environ.get("CANYONOS_PUBLIC_IP") or "127.0.0.1"
        api_port = endpoint.api_port or published_port
        base_url = f"http://{public_host}:{api_port}"
    routes = []
    for route in endpoint.routes:
        agent_name = qualified_name(route.project, route.agent)
        agent_spec = next(a for a in manifest.agents if a.name == agent_name)
        function = next(f for f in agent_spec.functions if f.name == route.method)
        record = {
            "project": route.project,
            "agent": route.agent,
            "method": route.method,
            "arguments": [argument.name for argument in function.arguments],
        }
        routes.append({**record, "url": base_url + route_path(record)})
    return {"public_host": public_host, "api_port": api_port, "routes": routes}


def publish_endpoint_port(redis_client, api_port):
    """Point the endpoint record at `api_port`, the port the endpoint's container got.
    Used by the reconciler after it launches the endpoint."""
    record = redis_client.hgetall(ADDRESS_KEY)
    base_url = f"http://{record['public_host']}:{api_port}"
    routes = [
        {**route, "url": base_url + route_path(route)}
        for route in json.loads(record["routes"])
    ]
    redis_client.hset_multiple(
        ADDRESS_KEY, {"api_port": api_port, "routes": json.dumps(routes)}
    )


def read_endpoint_record(redis_client):
    """Return the endpoint record the Global Controller published, with its port and
    routes decoded from their Redis strings, or None when nothing is published yet."""
    record = redis_client.hgetall(ADDRESS_KEY)
    if not record:
        return None
    return {
        **record,
        "api_port": int(record["api_port"]),
        "routes": json.loads(record["routes"]),
    }
