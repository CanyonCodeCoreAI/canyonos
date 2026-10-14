"""The CanyonOS endpoint: serves the configured agent method over HTTP.

`POST /<method>` queues a root call and answers with its request id;
`GET /status/<request_id>` reports the call's result once it is done.
"""

import json
import os

# The HTTP port inside the endpoint's container, and the default `api_port` it is
# published on.
ENDPOINT_PORT = 8080

# CPUs the endpoint's container gets; it runs one gunicorn worker per CPU.
ENDPOINT_CPUS = 2

# The name of the endpoint's replica spec, so no `agents:` entry may take it.
SERVICE_NAME = "endpoint"

# The dashboard API reads the endpoint's address here.
ADDRESS_KEY = "endpoint:address"


def endpoint_record(manifest):
    """Return where callers reach the endpoint of a validated manifest: its public host,
    port and URL, the agent and method it serves, and that method's argument names
    from its `functions:` entry. The Global Controller publishes it at ADDRESS_KEY."""
    endpoint = manifest.endpoint
    agent = next(agent for agent in manifest.agents if agent.name == endpoint.agent)
    function = next(f for f in agent.functions if f.name == endpoint.method)
    public_host = os.environ.get("CANYONOS_PUBLIC_IP") or "127.0.0.1"
    return {
        "public_host": public_host,
        "api_port": endpoint.api_port,
        "agent": endpoint.agent,
        "method": endpoint.method,
        "arguments": [argument.name for argument in function.arguments],
        "url": f"http://{public_host}:{endpoint.api_port}/{endpoint.method}",
    }


def read_endpoint_record(redis_client):
    """Return the endpoint record the Global Controller published, with its port and
    argument names decoded from their Redis strings, or None when nothing is
    published yet."""
    record = redis_client.hgetall(ADDRESS_KEY)
    if not record:
        return None
    return {
        **record,
        "api_port": int(record["api_port"]),
        "arguments": json.loads(record["arguments"]),
    }
