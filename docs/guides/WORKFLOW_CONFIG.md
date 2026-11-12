# Workflow config

The workflow config, `config/workflow_config.yaml`, describes your workflow: where it
runs, its agents, what each one installs and runs on, and the method the endpoint
serves. `canyonos deploy` starts exactly what it describes. This page lists every key it
accepts.

## Where it lives

The file is `config/workflow_config.yaml` in the [workflow root](BUILD_ARTIFACT.md), or
`.canyon/config/workflow_config.yaml` after `canyonos convert`. `canyonos new-app` and
`canyonos convert` write it for you.

- `canyonos config` views or edits it in the terminal, saves each change in place, and
  applies it to the running deploy. It doesn't create the file or fill in defaults.
- After you edit it in any editor, `canyonos sync` applies it to the running deploy.

With nothing deployed, changes apply on the next `canyonos deploy`.

## A small example

One agent that looks up stock prices, and the `Workflow` agent that takes each request
and calls it:

```yaml
target: docker
provider: local

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
  agent: Workflow
  method: main
```

`target: docker` and `provider: local` run it with Docker on this machine; both are
defaults you can leave out. CanyonOS runs two replicas of `PriceAgent`, the class of
that name in `agents/price_agent.py`, each with one CPU core and 256 MB of memory, and
installs `yfinance` into its image. Other agents call it through `get_price`. The
endpoint, on port `8080`, runs `Workflow.main` for each `POST /main`.

The keys may come in any order.

## Agent entries

Everything CanyonOS runs is one entry under `agents:`. Its `type` picks the keys it
takes: `agent` (the default) is a Python class in your code, and `database` is a stock
database image, such as `postgres:16-alpine`.

Keys every entry takes:

| Key                | Default  | What it does                                                                                                                                              |
| ------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`             | required | The agent's name. Names are lowercased into the image tag, so `MapAgent` and `mapagent` in one file are rejected. `endpoint`, in any casing, is reserved. |
| `type`             | `agent`  | `agent` or `database`                                                                                                                                     |
| `replicas`         | `1`      | How many replicas run at once, at least 1. A database runs exactly 1.                                                                                     |
| `resources.cpu`    | `1`      | CPU cores per replica, passed to `docker run --cpus`                                                                                                      |
| `resources.memory` | `512`    | Memory per replica in MB, passed to `--memory`                                                                                                            |
| `resources.gpu`    | none     | GPUs per replica, passed to `--gpus`. `0` means none.                                                                                                     |
| `stateful`         | `false`  | Send every call within one request to the same replica, for an agent that keeps state in memory between calls                                             |
| `env`              | `{}`     | Extra environment variables. On Docker and EC2 only database entries get them; on Kubernetes every entry does.                                            |

`canyonos deploy` writes the default `resources` into every entry, databases included,
so a database gets 1 CPU and 512 MB unless you set more.

Keys of `type: agent`:

| Key            | Default  | What it does                                                                                                                                             |
| -------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entrypoint`   | required | The `.py` file that holds the class named `name`, relative to the workflow root, with no `..`. `name` must be that class's name and a Python identifier. |
| `requirements` | `[]`     | The packages this agent's image installs, one PEP 508 requirement per item. See [Per-image requirements](#per-image-requirements).                       |
| `functions`    | `[]`     | The methods other agents and the endpoint can call; an agent without any cannot be called. See [Agent functions](#agent-functions).                      |

Keys of `type: database`:

| Key           | Default  | What it does                                                                                                                        |
| ------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `image`       | required | The Docker image to pull. Nothing is built for a database.                                                                          |
| `db_port`     | `5432`   | On Docker, the host port, mapped to `5432` inside, so the image must listen on `5432`. On Kubernetes, the port the image listens on |
| `volume_path` | none     | A folder inside it whose data survives a redeploy. Required on Kubernetes.                                                          |

On Docker, `volume_path` is kept on the volume `canyonos-<folder>-<id>-<name>-data`: the
workflow folder's name, the first 8 characters of `project_id`, and the entry's name in
lowercase.

A database needs no code. Other agents find it in the routing table, the Redis hash
`routing_table:addresses`, which maps the entry's name to a JSON list of `host:port`
strings. Every container reaches that Redis at `CANYONOS_REDIS_HOST` and
`CANYONOS_REDIS_PORT`, with the password in `CANYONOS_REDIS_PASSWORD`.

Use a database for state that must outlive a process, such as a framework's
checkpointer or memory store. Point that client at the database's address instead of
an in-process store, and the agent no longer needs `replicas: 1` to keep its state
consistent.

## Agent functions

`functions` lists the methods of the agent's stub, the class other agents call it
through. An agent that declares none gets a stub with nothing to call. How stubs are
built and used is in [Runtime contract](RUNTIME_CONTRACT.md#agent-functions-and-stubs).

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

| Key                | Required | What it does                               |
| ------------------ | -------- | ------------------------------------------ |
| `name`             | yes      | The method's name                          |
| `arguments[].name` | yes      | An argument's name                         |
| `arguments[].type` | no       | The argument's type, written into the stub |
| `returns.type`     | no       | The type callers receive the result as     |

Every name is written into the stub as Python source, so it must be a Python identifier
that is not a keyword. Some names are also rejected:

| Name     | Also rejected                                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agent    | `Future`, `inspect` and `isinstance`, which the stub uses itself                                                                                       |
| Function | A builtin type name such as `list` or `str` (it would shadow the type inside the class), a dunder such as `__init__`, or one already on the same agent |
| Argument | `self`, another argument's name, and `Future`, `inspect` and `isinstance`                                                                              |

A `type` becomes an annotation in a stub that imports nothing, so it must be built from
builtins: `bool`, `bytearray`, `bytes`, `complex`, `dict`, `float`, `frozenset`, `int`,
`list`, `object`, `set`, `str`, `tuple`, `None`, and compositions like `list[str]`,
`dict[str, int]`, `tuple[int, ...]` or `int | None`. `List[str]` or `Optional[str]` is
rejected. Stubs have no defaults, so every declared argument is required at the call
site.

`returns.type` decides what callers get. The result travels as text: a `dict` or `list`
JSON-encoded, anything else as a string. Callers get it back as the declared type: `dict`
and `list` from JSON, numbers and `bool` from their text. Without `returns.type`, callers
get the text; see [Results of agent calls](RUNTIME_CONTRACT.md#results-of-agent-calls).

## Per-image requirements

Each agent's image installs the platform's base list plus that entry's
`requirements`, and nothing else. Your application's `requirements.txt` and
`pyproject.toml` are not installed, and no image runs `pip install -e .`.

| Base package | Floor      | Cap  |
| ------------ | ---------- | ---- |
| `grpcio`     | `>=1.76.0` | `<2` |
| `protobuf`   | `>=6.31.1` | `<7` |
| `redis`      | `>=3.5`    | `<9` |

The cap is the next major version after the one the build has tested. Your list can ask
for a newer one, which only warns. A pin below the floor, such as `protobuf<5`, fails
the build before Docker runs. The LLM Gateway has its own virtualenv in the image, so
its pins never meet yours.

Declare every runtime distribution per entry, by the name PyPI installs, not the name
Python imports: `import yaml` installs as `PyYAML`, `import cv2` as `opencv-python`, and
`import speech_recognition` as `SpeechRecognition`. A wrong name passes the schema and
fails in the image build. Which versions to pin is in
[What a workflow needs](WORKFLOW_REQUIREMENTS.md#4-dependencies-declared-in-the-workflow-config).

To build an entry's list, follow module-level imports out of its entrypoint into the
copy. A package `__init__.py` on the way is real and runs first, so its imports count
too. Stop at another agent's `entrypoint`: that module is a stub in this image, so
nothing behind it runs here.

`requirements: []` on the endpoint's agent means that its module, and everything it
imports at module level, needs nothing beyond the base list. Every request starts in
that agent, so if it fails at import, the workflow cannot answer any request.

## Endpoint

`endpoint` is required. It names the agent method CanyonOS serves over HTTP:

```yaml
endpoint:
  agent: Workflow
  method: main
```

| Key        | Default                        | What it does                                                           |
| ---------- | ------------------------------ | ---------------------------------------------------------------------- |
| `agent`    | required                       | An entry of `type: agent`                                              |
| `method`   | required                       | One of that agent's `functions`, served at `POST /<method>`            |
| `api_port` | `8080`, else the next free one | The endpoint's port; see [Ports a deploy opens](#ports-a-deploy-opens) |

What a request looks like and what it returns is in
[Runtime contract](RUNTIME_CONTRACT.md#endpoint).

## Top-level keys

Every key at the top of the file. Any other key is rejected.

Where it runs:

| Key                    | Default               | What it does                                                                                                                                                                    |
| ---------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target`               | `docker`              | Who runs the workflow: `docker` on the machine that runs `canyonos deploy`, or `kubernetes` with the `kubernetes:` block. `canyonos target` sets it.                            |
| `kubernetes`           | none                  | Namespace, registry and other cluster settings; see [Kubernetes deployment](KUBERNETES.md#configuration)                                                                        |
| `provider`             | `local`               | Where the agents run with `target: docker`: `local` (this machine), `ec2-pool` or `ec2-assign`, in any casing. See [Run it somewhere else](CONFIGURE.md#run-it-somewhere-else). |
| `ec2-pool`             | none                  | The EC2 machines for `provider: ec2-pool`; see [EC2 deployment](EC2.md#configuration)                                                                                           |
| `ec2-assign`           | none                  | Each agent's EC2 machine type for `provider: ec2-assign`; see [EC2 deployment](EC2.md#configuration)                                                                            |
| `ssh_private_key_path` | `~/.ssh/canyonos_ec2` | The key for SSH to EC2 machines; see [EC2 deployment](EC2.md#configuration)                                                                                                     |

What it runs:

| Key        | Default  | What it does                                           |
| ---------- | -------- | ------------------------------------------------------ |
| `agents`   | required | The [agent entries](#agent-entries)                    |
| `endpoint` | required | The method served over HTTP; see [Endpoint](#endpoint) |

The rest have defaults that suit most workflows, so `canyonos new-app` and the examples
leave them out:

| Key                 | Default                        | What it does                                                                                                                                                                                                        |
| ------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `otel.destinations` | the local dashboard            | Where telemetry goes; see [`otel.destinations`](#oteldestinations)                                                                                                                                                  |
| `logs`              | `true`                         | Capture each agent's log lines with the call that wrote them. `false` keeps only errors.                                                                                                                            |
| `dashboard_port`    | `8081`, else the next free one | The local dashboard's port                                                                                                                                                                                          |
| `redis.host`        | `localhost`                    | The Global Controller's Redis. It requires a password, which the first deploy makes and keeps in `~/.canyonos/projects/<project>/redis_password`; `canyonos clean` deletes it, and the next deploy makes a new one. |
| `redis.port`        | `6379`, else the next free one | Its port                                                                                                                                                                                                            |
| `redis.db`          | `0`                            | Its database number                                                                                                                                                                                                 |
| `poll_interval`     | `5`                            | Seconds between the Global Controller's checks that everything runs. Replicas get it as `CANYONOS_POLL_INTERVAL`.                                                                                                   |
| `cleanup_interval`  | `10`                           | Most seconds between passes that clear finished requests                                                                                                                                                            |
| `project_id`        | written by the first deploy    | Identifies the workflow on the dashboard and in its Docker names. Leave it out of a new workflow, and don't change it.                                                                                              |

Leave `api_port`, `redis.port` and `dashboard_port` unset unless something needs a
fixed port: a port you set is never moved, so a taken one stops the deploy.

### `otel.destinations`

Without this block, telemetry goes to the local dashboard. A block replaces that
default, so list `local` (as below) beside any other destination.

```yaml
otel:
  destinations:
    - name: local
      protocol: http
      endpoint: http://canyonos-dashboard-api:3000
      headers: {}
```

| Key        | Default  | What it does                                                                    |
| ---------- | -------- | ------------------------------------------------------------------------------- |
| `name`     | required | A name unique in the list                                                       |
| `protocol` | required | `grpc`, `http` or `http/protobuf`                                               |
| `endpoint` | required | Where to send it. For `http`, the base URL; gRPC endpoints are used as written. |
| `headers`  | none     | Headers to send, such as an API key, as a mapping of strings                    |
| `insecure` | none     | `true` for a gRPC endpoint without TLS. HTTP destinations ignore it.            |
| `timeout`  | none     | Seconds to wait for each export                                                 |

For `http`, the exporter appends `/v1/traces`, `/v1/metrics` and `/v1/logs` itself. An
endpoint that already ends in `/v1/traces` passes validation and then posts to
`/v1/traces/v1/traces`.

Only the Global Controller exports telemetry, so a destination only needs to be
reachable from it: on Docker, from the machine that runs `canyonos deploy`.
`http://canyonos-dashboard-api:3000` names the local dashboard's API. The dashboard
joins each workflow's Docker network, so the address works whatever host port the API
is on.

On Kubernetes, a destination on the local dashboard or on `host.docker.internal` is
skipped with a warning, and telemetry also goes to the cluster's dashboard when it has
one.

## Environment variables

Any string value can come from an environment variable, written as `${NAME}`:

```yaml
ec2-pool:
  region: ${EC2_REGION}
```

- The value comes from the workflow's `.env`: the one beside `config/`, or, after
  `canyonos convert`, the one beside `.canyon` when there is one. A variable already set
  in the environment the config is read in keeps its own value.
- Numbers, such as `replicas` and ports, and booleans can't use a variable.
- A variable that isn't set stays as written, which is an error in a required key.

## Ports a deploy opens

With `target: docker`, a deploy opens these ports on the machine that runs
`canyonos deploy`, and no others:

| What                                | Setting             | Default                                                   | Open on         |
| ----------------------------------- | ------------------- | --------------------------------------------------------- | --------------- |
| Endpoint                            | `endpoint.api_port` | `8080`, else the next free one that isn't the dashboard's | every interface |
| Redis                               | `redis.port`        | `6379`, else the next free one                            | `127.0.0.1`     |
| Global Controller                   | none                | `8000`, else the next free one                            | `127.0.0.1`     |
| Each database                       | its `db_port`       | `5432`                                                    | every interface |
| Dashboard, shared by every workflow | `dashboard_port`    | `8081`, else the next free one                            | every interface |
| The dashboard's API                 | none                | `3000`, else the next free one                            | every interface |

Agents open no port: the Global Controller reaches them over the workflow's private
Docker network. The dashboard's own database opens none either: workflows reach it by
name on their Docker network, so a database of yours can keep `5432`.

With `provider: ec2-pool` or `ec2-assign`, each machine also opens `50051` and up for
its agents, on its private IP only; see [EC2 deployment](EC2.md).

Every port is picked by these rules:

- **A port you set is never moved.** A taken `db_port`, `api_port` or `redis.port`
  stops the deploy with a message that names the setting; a taken `dashboard_port`
  stops only the dashboard. A `redis.port` held by this workflow's own Redis, left by a
  deploy that crashed, is reused.
- **A port you didn't set** starts at the one it had last deploy, or its default. It
  moves to the next one that is free and that nothing else of CanyonOS on this machine
  holds or has picked: another workflow's Global Controller, Redis or endpoint, a
  Kubernetes port-forward, or the dashboard's ports. `canyonos deploy` says when the
  Global Controller, the endpoint, Redis or the dashboard's API moved.
- **Deploys started at the same moment** pick their ports one at a time, so each gets
  its own.
- **A port taken after it was picked**, by something outside CanyonOS, moves the Global
  Controller, the endpoint or the dashboard on to the next one by the same rules. Redis
  stops the deploy instead; deploying again picks another.
- **A dashboard already running** is reused on its own port. `canyonos deploy` warns
  when that isn't this workflow's `dashboard_port`.

## Errors

`canyonos deploy` checks the whole file before it starts anything, and
`canyonos validate` runs the same check. A misspelled key, a value of the wrong type, or
an `entrypoint` that doesn't exist stops the deploy. Every problem is listed at once, as
`file:line: key: message`, so you can fix them all in one pass. A misspelled key names
the closest valid one.

`canyonos sync` and `canyonos config` check the edited file too. When it has a problem,
a running deploy keeps its current config.

Some keys are retired, and the error says what to do instead:

| Key                                                       | What to do                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------- |
| `database`                                                | Remove it; telemetry is set under `otel:`                     |
| `env_file`                                                | Remove it; the workflow's `.env` reaches the agents by itself |
| `ec2`                                                     | Rename it to `ec2-pool`                                       |
| `provider: EC2`                                           | Use `provider: ec2-pool`                                      |
| `ssh_private_key_path` under `ec2-pool:` or `ec2-assign:` | Move it to the top level                                      |
