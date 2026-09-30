# Manifest reference

Two kinds of file live in `.car/config/`: the manifest
`global_controller.yaml`, and one yaml declaration per agent service. The
schema in `canyonos_core/schema` checks both before anything is built. A key
it does not know is an error, so this page lists every key it accepts.

## `global_controller.yaml`

### Service entries

Every entry under `agents:` is a service. `type` picks which extra keys it
takes. Without `type` it is an agent.

Keys every entry accepts:

| Key | Default | Notes |
|---|---|---|
| `name` | required | Must equal the yaml `agent.name` and the class name in the entrypoint. Names are lowercased into the image tag, so `MapAgent` and `mapagent` in one manifest is a duplicate and the deploy is rejected. |
| `type` | `agent` | One of `agent`, `workflow`, `database`. |
| `provider` | `local` | `local` or `EC2`, in any casing. |
| `replicas` | `1` | Integer, at least 1. A local workflow must be 1. A database must be 1. |
| `redis_port` | `6379` | Host port of the Redis this service talks to. Entries on one host must agree. |
| `resources.cpu` | `1` | Passed to `docker run --cpus`. |
| `resources.memory` | `512` | MiB, passed to `--memory`. |
| `resources.gpu` | none | Integer. `0` means no GPU. Passed to `--gpus`. |
| `stateful` | `false` | Marks the service stateful in the routing table, so every call within one request goes to the same replica. |
| `instance_type` | none | Required when `provider: EC2`. |
| `env` | `{}` | Extra `-e` variables. Only applied to `database` entries today. |
| `host`, `user` | this machine, none | For the local provider: run the container on another Docker host reached over SSH as `user`. |
| `host_port` (or `port`) | next free port | Host port published for the service's gRPC endpoint. |

Agent entries add:

| Key | Default | Notes |
|---|---|---|
| `entrypoint` | required | `.py` path relative to `.car/app`, no `..`, not absolute. Holds the class named `name`. |
| `requirements` | `[]` | One PEP 508 requirement per item. See [Per-image requirements](#per-image-requirements). |

Workflow entries add:

| Key | Default | Notes |
|---|---|---|
| `workflow_file` | required | `.py` path relative to `.car/app`, same rules as `entrypoint`. |
| `requirements` | `[]` | Same rules. The agents' lists do not apply here. |
| `api_port` | `8080` | Host port where the workflow's HTTP API is published. |
| `dashboard_port` | `8081` | Host port of the local dashboard. |

Database entries add:

| Key | Default | Notes |
|---|---|---|
| `image` | required | Docker image to pull. Nothing is built for a database. |
| `db_port` | `5432` | Port the database listens on. |
| `volume_path` | none | Mount point for a named volume `canyonos-<name>-data`. |

A database entry needs no yaml declaration and no code. Other services reach
it through the routing table: the Redis hash `routing_table:endpoints` maps
the entry name to a JSON list of `host:port` strings, on the Redis every
container reaches through `CANYONOS_REDIS_HOST` and `CANYONOS_REDIS_PORT`.

Use one for state that must outlive a process, such as a framework's
checkpointer or memory store. Build that client against the resolved address
instead of an in-process store, and the agent no longer needs
`replicas: 1` to keep the state consistent.

### Top-level keys

| Key | Default | Notes |
|---|---|---|
| `agents` | required | The service list above. |
| `poll_interval` | `5` | Seconds between Global Controller loop iterations. Also exported to containers as `CANYONOS_POLL_INTERVAL`. |
| `cleanup_interval` | `10` | Seconds between cleanup passes. |
| `project_id` | generated | Written back into the file on first deploy. Leave it out on a new project. |
| `redis.host` / `redis.port` / `redis.db` | `localhost` / `6379` / `0` | The controller's own Redis. |
| `env_file` | none | Secrets file passed to every container. Resolved against the directory `canyonos deploy` runs from, the one holding `.car`. A missing or unreadable file fails the deploy before anything starts. |
| `logs` | `true` | Stream failure detail into each future. |
| `otel.destinations` | none | Where telemetry goes. See below. |
| `ec2` | none | Required when any entry uses `provider: EC2`. See [EC2 deployment](ec2.md). |

`database` used to be a top-level key. It is retired: the schema rejects it
with "is no longer used; telemetry is configured under otel:". Remove it.

In a managed deployment `env_file` is ignored with a warning and secrets come
from the platform's own file instead.

### `otel.destinations`

Without this block the exporter still runs but sends nothing, and the log
says so once at startup. The list is consumed by the Global Controller's
exporter only, on the machine that runs `canyonos deploy`, so an endpoint
only needs to be reachable from there.

```yaml
otel:
  destinations:
    - name: local
      protocol: http
      endpoint: http://host.docker.internal:3000
      headers: {}
```

Each destination takes `name`, `protocol`, `endpoint`, and optionally
`headers`, `insecure` and `timeout`. `protocol` is `grpc`, `http` or
`http/protobuf`. For `http` the exporter appends `/v1/traces`, `/v1/metrics`
and `/v1/logs` itself, so give the base URL. An endpoint that already ends in
`/v1/traces` passes validation and then posts to `/v1/traces/v1/traces`.
gRPC endpoints are used as written.

The local dashboard's API listens on port 3000 on the host, which is what
`host.docker.internal:3000` reaches from inside the controller container.

### Example

```yaml
agents:
  - name: EmailAgent
    entrypoint: email_assistant.py
    provider: local
    replicas: 1
    resources:
      cpu: 1
      memory: 1024
    requirements:
      - langgraph
      - langchain-openai

  - name: Workflow
    type: workflow
    workflow_file: email_workflow.py
    api_port: 8080
    requirements:
      - langgraph

poll_interval: 5

redis:
  host: localhost
  port: 6379
  db: 0

env_file: .env

otel:
  destinations:
    - name: local
      protocol: http
      endpoint: http://host.docker.internal:3000
      headers: {}
```

### Editing with `canyonos config`

`canyonos config` opens the existing `global_controller.yaml` in a small
terminal UI. View shows what is in the file. Change lets you edit or delete a
key and saves in place. It does not create the file or fill in defaults.

## Agent declarations

Any `*.yaml` in `.car/config/` with a top-level `agent.name` is a
declaration. The filename does not matter; `global_controller.yaml` and
`policy.yaml` are skipped because they have no `agent` block. If two files
declare the same `agent.name`, the last one in sorted filename order wins and
nothing warns you.

```yaml
agent:
  name: ExampleAgent
  functions:
    - name: work
      description: Optional text
      arguments:
        - name: query
          type: str
      returns:
        type: dict
```

Only `agent`, `functions`, `name`, `description`, `arguments`, `returns` and
`type` are accepted where shown.

Argument `type` becomes an annotation in a generated stub that imports
nothing, so it has to be built from builtins: `bool`, `bytearray`, `bytes`,
`complex`, `dict`, `float`, `frozenset`, `int`, `list`, `object`, `set`,
`str`, `tuple`, `None`, and compositions like `list[str]`, `dict[str, int]`,
`tuple[int, ...]` or `int | None`. `List[str]` or `Optional[str]` is a schema
error. Every declared argument is required at the call site; stubs have no
defaults.

`returns.type` is documentation. The runtime JSON-encodes a `dict` or `list`
result and turns anything else into a string, and a workflow always receives
text back, so `dict` or `list` tells the caller to `json.loads` it.

## Per-image requirements

Each image installs the platform's base list plus that entry's
`requirements`, and nothing else. The base list is `grpcio>=1.76.0`,
`protobuf>=6.31.1`, `redis>=3.5`, plus `flask>=2.3.3` for the workflow image.
The build caps those four below the next major it has tested (`grpcio<2`,
`protobuf<7`, `redis<9`, `flask<4`) unless your list asks for newer, which
only warns. A pin below the base floor, such as `protobuf<5`, fails the build
before Docker runs. The LLM proxy has its own virtualenv in the image, so its
pins never meet yours.

The application's own `requirements.txt` and `pyproject.toml` are not
installed. No image runs `pip install -e .`. Declare every runtime
distribution per entry, by the name PyPI installs, not the name Python
imports: `import yaml` installs as `PyYAML`, `import cv2` as `opencv-python`,
`import speech_recognition` as `SpeechRecognition`. A wrong name passes the
schema and fails in the image build.

Follow module-level imports out of the entrypoint into the copy to build the
list. Stop at another service's `entrypoint`: that module is a stub in this
image, so nothing behind it runs here. A package `__init__.py` on the way is
real and runs first, so its imports count too.

`requirements: []` on the workflow entry means the workflow module and
everything it imports at module level needs nothing beyond the base list. The
workflow container is the only one serving HTTP, so if it dies at import the
deployment has no entry point.
