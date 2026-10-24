# global_controller.yaml

Global Controller is our central authority and control plane inside CanyonOS. It handles things such as deployment, scaling, and pulling telemetry.

`global_controller.yaml` is the one file that tells global controller how to deploy everything. When
you run `canyonos deploy`, CanyonOS reads this file and starts exactly what it
describes.

## Where it lives

`canyonos convert` can write the file for you at `.canyon/config/global_controller.yaml`. A
project that doesn't use `canyonos convert` keeps it at `config/global_controller.yaml`.

You can change it in two ways:

- Run `canyonos config` to view and edit it step by step in the terminal.
- Open it in any editor.

Either way, run `canyonos deploy` again to apply the change.

## A small example

This file runs one agent that looks up stock prices, and the `Workflow` agent that calls it:

```yaml
agents:
  - name: PriceAgent
    entrypoint: agents/price_agent.py
    replicas: 2
    resources:
      cpu: 1
      memory: 256
    requirements: [yfinance]
    functions:
      - name: get_price
        arguments:
          - name: ticker
            type: str
        returns:
          type: dict

  - name: Workflow
    entrypoint: agents/workflow.py
    functions:
      - name: main
        arguments:
          - name: query
            type: str

endpoint:
  api_port: 8080
  agent: Workflow
  method: main

env_file: .env
```

Reading it top to bottom:

- `PriceAgent` is an agent whose code is in `agents/price_agent.py`. CanyonOS runs two
  copies of it, each with one CPU core and 256 MB of memory, and installs `yfinance`
  into it. `functions` lists the methods the workflow calls on it, here `get_price`.
- `Workflow` is the agent that takes each request and calls your other agents to
  answer it. Its `functions` list `main`, the method the endpoint serves.
- `endpoint` is the web address CanyonOS serves for you, on port `8080`. A request to
  `POST /main` runs the `main` method of the `Workflow` class.
- `env_file` points at a `.env` file. Every piece of your app gets its variables, so
  that's where API keys go.

## The `agents` list

Everything CanyonOS runs is one entry in `agents`, and every entry needs a `name`. Its
`type` says what kind of thing it is:

| `type` | What it is | What it needs |
|---|---|---|
| `agent` (the default) | A Python class that does one job in your app | `entrypoint`: the file the class is in |
| `database` | A ready-made database, such as Postgres | `image`: the Docker image to run, for example `postgres:16-alpine` |

An agent's `name` must match its class name, so `PriceAgent` runs the `PriceAgent`
class in its `entrypoint` file.

### How much to run

- `replicas`: how many copies to run at once. More copies handle more requests at the
  same time. The default is `1`.
- `resources`: what each copy gets: `cpu` cores (default `1`), `memory` in MB (default
  `512`), and `gpu` count (default none).

### What to install

- `requirements`: the Python packages your agent imports, like
  `[yfinance, pandas]`. CanyonOS installs these into that entry only. It does not read
  your app's own `requirements.txt`, so list everything the entry needs here.

### Where it runs

- `provider`: `local` (the default) runs on this machine. `EC2` runs on Amazon EC2
  and also needs `machine_type`, such as `t3.micro`, and the top-level `ec2` section
  below.

### Other settings

- `env`: environment variables for this entry only, on top of the ones from
  `env_file`.
- `stateful`: set to `true` if a copy keeps information in memory between calls in the
  same request. CanyonOS then sends every call in that request to the same copy.
- For a database, `db_port` is the port it listens on (default `5432`), and
  `volume_path` is a folder inside it whose data should survive a redeploy.

## Settings for the whole deployment

These go at the top level of the file, next to `agents`:

- `env_file`: a `.env` file whose variables every entry gets. Put API keys here, not
  in the YAML.
- `endpoint` (required): the web address requests arrive at. `api_port` is its port
  (default `8080`), and `agent` and `method` name the agent method served at
  `POST /<method>`. The method must be listed in that agent's `functions`.
- `dashboard_port`: where the dashboard opens (default `8081`).
- `ec2`: the AWS details used for every entry with `provider: EC2`: `region`,
  `subnet_id`, and `security_group_ids` are required; `ami_id` and `ssh_user` have
  defaults. See [EC2 deployment](EC2.md).
- `otel`: where to send your app's traces, metrics, and logs, if you use an
  observability tool. Each destination has a `name`, a `protocol` (`grpc`, `http`, or
  `http/protobuf`), and an `endpoint`.
- `poll_interval`: how often, in seconds, the Global Controller checks that everything
  is running (default `5`).
- `redis`: where CanyonOS keeps track of your running app (default `localhost:6379`).
  Most projects leave this alone.
- `project_id`: filled in by the first deploy. Leave it as it is.

## Using environment variables

Any text value can come from an environment variable, written as `${NAME}`:

```yaml
ec2:
  region: ${EC2_REGION}
```

CanyonOS looks in the project's `.env` file first. Numbers, such as `replicas` and
ports, can't use a variable.

## When something is wrong

`canyonos deploy` checks the whole file before it starts anything. A misspelled key,
a value of the wrong type, or a file that doesn't exist stops the deploy. It lists
every problem at once, each with the line it's on, so you can fix them all in one pass.

## Reference

The schema in `canyonos_core/schema` checks the manifest
`global_controller.yaml` before anything is built. A key it does not know is
an error, so this page lists every key it accepts.

### `global_controller.yaml`

#### Agent entries

Every entry under `agents:` is an agent. `type` picks which extra keys it
takes. Without `type` it is an agent.

Keys every entry accepts:

| Key | Default | Notes |
|---|---|---|
| `name` | required | Must equal the class name in the entrypoint. Names are lowercased into the image tag, so `MapAgent` and `mapagent` in one manifest is a duplicate and the deploy is rejected. |
| `type` | `agent` | One of `agent`, `database`. |
| `provider` | `local` | `local` or `EC2`, in any casing. |
| `replicas` | `1` | Integer, at least 1. A database must be 1. |
| `resources.cpu` | `1` | Passed to `docker run --cpus`. |
| `resources.memory` | `512` | MiB, passed to `--memory`. |
| `resources.gpu` | none | Integer. `0` means no GPU. Passed to `--gpus`. |
| `stateful` | `false` | Marks the agent stateful in the routing table, so every call within one request goes to the same replica. |
| `machine_type` | none | Required when `provider: EC2`. |
| `env` | `{}` | Extra `-e` variables. Only applied to `database` entries today. |

Agent entries add:

| Key | Default | Notes |
|---|---|---|
| `entrypoint` | required | `.py` path relative to the project root, or to `.canyon/app` in a ported artifact; no `..`, not absolute. Holds the class named `name`. |
| `requirements` | `[]` | One PEP 508 requirement per item. See [Per-image requirements](#per-image-requirements). |
| `functions` | `[]` | The methods other agents can call; an agent without any cannot be called. See [Agent functions](#agent-functions). |

Database entries add:

| Key | Default | Notes |
|---|---|---|
| `image` | required | Docker image to pull. Nothing is built for a database. |
| `db_port` | `5432` | Port the database listens on. |
| `volume_path` | none | Mount point for a named volume `canyonos-<project>-<name>-data`. |

A database entry needs no code. Other agents reach
it through the routing table: the Redis hash `routing_table:addresses` maps
the entry name to a JSON list of `host:port` strings, on the Redis every
container reaches through `CANYONOS_REDIS_HOST` and `CANYONOS_REDIS_PORT`.

Use one for state that must outlive a process, such as a framework's
checkpointer or memory store. Build that client against the resolved address
instead of an in-process store, and the agent no longer needs
`replicas: 1` to keep the state consistent.

#### Top-level keys

| Key | Default | Notes |
|---|---|---|
| `agents` | required | The agent list above. |
| `poll_interval` | `5` | Seconds between Global Controller loop iterations. Also exported to containers as `CANYONOS_POLL_INTERVAL`. |
| `cleanup_interval` | `10` | Seconds between cleanup passes. |
| `project_id` | generated | Written back into the file on first deploy. Leave it out on a new project. |
| `redis.host` / `redis.port` / `redis.db` | `localhost` / `6379` / `0` | The controller's own Redis. |
| `env_file` | none | Secrets file passed to every container. Resolved against the directory `canyonos deploy` runs from, the one holding `.canyon`. A missing or unreadable file fails the deploy before anything starts. |
| `logs` | `true` | Stream failure detail into each future. |
| `otel.destinations` | none | Where telemetry goes. See below. |
| `ec2` | none | Required when any entry uses `provider: EC2`. See [EC2 deployment](EC2.md). |
| `endpoint.api_port` | `8080` | Host port of the HTTP endpoint, published on the machine that runs `canyonos deploy`. |
| `endpoint.agent` | required | The entry of type `agent` the endpoint serves. |
| `endpoint.method` | required | One of that agent's `functions`, served at `POST /<method>`. |
| `dashboard_port` | `8081` | Host port of the local dashboard. |
| `ssh_private_key_path` | `~/.ssh/canyonos_ec2` | The key every SSH connection to a remote host uses. |

`database` used to be a top-level key. It is retired: the schema rejects it
with "is no longer used; telemetry is configured under otel:". Remove it.

In a managed deployment `env_file` is ignored with a warning and secrets come
from the platform's own file instead.

#### `otel.destinations`

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

#### Example

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
    functions:
      - name: draft_reply
        arguments:
          - name: thread
            type: str
        returns:
          type: str

  - name: Workflow
    entrypoint: email_workflow.py
    requirements:
      - langgraph
    functions:
      - name: main
        arguments:
          - name: thread
            type: str

endpoint:
  api_port: 8080
  agent: Workflow
  method: main

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

#### Editing with `canyonos config`

`canyonos config` opens the existing `global_controller.yaml` in a small
terminal UI. View shows what is in the file. Change lets you edit or delete a
key and saves in place. It does not create the file or fill in defaults.

### Agent functions

`functions` on an agent entry lists the methods of its stub. An agent that
declares none gets a stub with nothing to call.

```yaml
agents:
  - name: MetricsAgent
    entrypoint: agents/metrics_agent.py
    functions:
      - name: compute
        arguments:
          - name: ticker
            type: str
          - name: lookback_days
            type: int
        returns:
          type: dict
```

Only `name`, `arguments`, `returns` and `type` are accepted where shown.

Every `name` is written into the stub as Python source, so it has to be a
Python identifier that is not a keyword. A function name is also rejected
when it is a builtin type name such as `list` or `str` (it would shadow the
type inside the class), a dunder such as `__init__`, or already declared on
the same agent. An argument cannot be `self` or repeat another argument.

A `type`, on an argument or under `returns`, becomes an annotation in a
generated stub that imports nothing, so it has to be built from builtins:
`bool`, `bytearray`, `bytes`, `complex`, `dict`, `float`, `frozenset`, `int`,
`list`, `object`, `set`, `str`, `tuple`, `None`, and compositions like
`list[str]`, `dict[str, int]`, `tuple[int, ...]` or `int | None`. `List[str]`
or `Optional[str]` is a schema error. Every declared argument is required at
the call site; stubs have no defaults.

At runtime `returns.type` is documentation. The runtime JSON-encodes a `dict`
or `list` result and turns anything else into a string, and a calling agent always
receives text back, so `dict` or `list` tells the caller to `json.loads` it.

### Per-image requirements

Each image installs the platform's base list plus that entry's
`requirements`, and nothing else. The base list is `grpcio>=1.76.0`,
`protobuf>=6.31.1` and `redis>=3.5`.
The build caps those three below the next major it has tested (`grpcio<2`,
`protobuf<7`, `redis<9`) unless your list asks for newer, which
only warns. A pin below the base floor, such as `protobuf<5`, fails the build
before Docker runs. The LLM gateway has its own virtualenv in the image, so its
pins never meet yours.

The application's own `requirements.txt` and `pyproject.toml` are not
installed. No image runs `pip install -e .`. Declare every runtime
distribution per entry, by the name PyPI installs, not the name Python
imports: `import yaml` installs as `PyYAML`, `import cv2` as `opencv-python`,
`import speech_recognition` as `SpeechRecognition`. A wrong name passes the
schema and fails in the image build.

Follow module-level imports out of the entrypoint into the copy to build the
list. Stop at another agent's `entrypoint`: that module is a stub in this
image, so nothing behind it runs here. A package `__init__.py` on the way is
real and runs first, so its imports count too.

`requirements: []` on the endpoint's target agent means its module and
everything it imports at module level needs nothing beyond the base list. Every
request starts in that agent, so if it dies at import the deployment cannot
answer any.
