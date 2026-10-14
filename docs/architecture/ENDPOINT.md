# Endpoint — Architecture

The endpoint is the HTTP door into a deployment. It serves one agent method, named by
the top-level `endpoint:` block in `global_controller.yaml`, at `POST /<method>`, and
reports each request's result at `GET /status/<request_id>`. It runs no agent code: it
queues the call and forwards it to a replica of the agent it serves.

## Where it runs

The Global Controller adds the endpoint to the agent list itself, as an entry named
`endpoint` with `type: endpoint`, so the reconciler launches and replaces it like any
other replica. The name `endpoint` is reserved for it.

```mermaid
flowchart LR
    client([HTTP client]) -->|"api_port (8080)"| ep
    subgraph host["machine that runs canyonos deploy"]
        gc["canyonos-{project}-global-controller"]
        ep["canyonos-{project}-endpoint-0<br/>gunicorn + routing-only LocalController"]
        redis[("canyonos-{project}-redis-{host}")]
        gc -->|"reconciler launches"| ep
        ep --- redis
    end
    ep -->|"gRPC Execute"| replica["replica of endpoint.agent<br/>LocalController + agent code"]
    replica -->|"gRPC WriteResult"| ep
```

| | |
|---|---|
| Container | `canyonos-<project>-endpoint-0`, one replica, 2 CPUs, always on the Local provider |
| Image | the Global Controller's image, started as `python -m canyonos_core.endpoint` |
| HTTP | gunicorn on `8080` inside the container, 2 workers × 16 threads, published on `endpoint.api_port` (default `8080`) |
| gRPC | a Local Controller that only routes, on `50051` inside the container, published on a host port the provider claims like an agent replica's |
| Scaling | never: autoscaling only acts on entries of type `agent` |

## Manifest block

```yaml
endpoint:
  agent: Workflow
  method: main
  api_port: 8080
```

`agent` must be an entry of type `agent`, and `method` must be listed in that agent's
`functions`. The argument names `canyonos test`, the deploy summary and the dashboard
use come from that function's `arguments`. See
[global_controller.yaml](../guides/GLOBAL_CONTROLLER.md).

## A request end to end

```mermaid
sequenceDiagram
    autonumber
    participant C as HTTP client
    participant E as Endpoint (Flask)
    participant LC as Endpoint LocalController
    participant R as Redis
    participant A as Agent replica

    C->>E: POST /{method} {"query": "..."}
    E->>R: SET request:{id}:context (when _context is sent)
    E->>R: HSET future:{future_id} (Future(agent, method, kwargs))
    E->>LC: gRPC Execute (localhost:50051)
    E->>R: SET request:{id}:future
    E-->>C: 202 {"request_id": {id}}
    LC->>A: gRPC Execute (routed by routing_table:endpoints)
    A->>A: run {method}(**kwargs), resolve Futures in the result
    A->>LC: gRPC WriteResult (result or error)
    LC->>R: HSET future:{future_id} result / failed
    C->>E: GET /status/{id}
    E->>R: GET request:{id}:future, HGETALL future:{future_id}
    E-->>C: pending | done + result | error + error
```

The body must be a JSON object. Each key becomes a keyword argument, and `_context` is
taken out first and kept for policy. An empty body is a call with no arguments; anything
else is a `400`. A finished request's keys expire after cleanup, and `GET /status` then
answers `404`.

## Forwarding and retries

The endpoint's Local Controller picks a replica of `endpoint.agent` from the routing
table, the same way an agent's controller routes a call to another agent, and does not
wait for the run. When the replica is unreachable (`UNAVAILABLE`) or does not accept the
request within 2 seconds (`DEADLINE_EXCEEDED`):

- the replica is skipped for 30 seconds while the reconciler replaces it, unless every
  replica is marked down;
- the request goes back on the queue: the first retry at once, later ones after 0.5 s,
  1 s, 2 s and so on, up to 8 s;
- after 8 retries, or on any other gRPC error, the request fails and `GET /status`
  reports `error`.

A timed-out request may already be queued on that replica; the replica drops the resend
as a duplicate. Once a replica has accepted the request the endpoint does not retry it,
so a replica that dies mid-run loses the request.

## Where callers find it

The Global Controller writes the Redis hash `endpoint:address` when it applies the
config and deletes it when the deploy stops:

| Field | Value |
|---|---|
| `public_host` | `CANYONOS_PUBLIC_IP`, or `127.0.0.1` |
| `api_port` | `endpoint.api_port` |
| `agent`, `method` | the served method |
| `arguments` | JSON list of the method's argument names, from `functions` |
| `url` | `http://<public_host>:<api_port>/<method>` |

Readers:

- the Global Controller container's server answers `GET /endpoint` on port `8000` with
  the same record, which the CLI uses for `canyonos test` and the deploy summary;
- the dashboard API answers `GET /projects/:project_id/monitoring/endpoint` with
  `{endpoint: {url, status_url, agent, method, arguments, example_body}}`, or
  `{endpoint: null}` when the hash is missing.
