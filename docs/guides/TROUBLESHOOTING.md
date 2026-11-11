# Troubleshooting

Problems you may hit with a workflow, in the order they show up: installing, deploying,
starting, serving requests and stopping. Find the message or symptom in the table for
that step; each row gives the likely cause and the fix.

## First checks

These commands narrow most problems down:

```bash
canyonos doctor          # can this machine deploy, and is every part of the deploy up?
canyonos validate        # does the code follow the runtime contract?
canyonos status          # how many replicas of each agent are running
canyonos logs            # the Global Controller's log
canyonos logs MyAgent    # one agent's log
```

`canyonos validate` reports problems as codes such as `CANYON-ADAPTER-CLASS`.
[Images and dependencies](IMAGES_AND_DEPENDENCIES.md#what-canyonos-validate-checks)
lists them.

## Installing and `canyonos doctor`

| Symptom                                                                          | Likely cause                                              | Fix                                                                                                        |
| -------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `canyonos: command not found`                                                    | The CLI's install folder isn't on `PATH` in this terminal | Open a new terminal. If it persists, [install](../INSTALLATION.md) again                                   |
| `Cannot connect to the Docker daemon`, or `doctor` fails `Docker daemon running` | Docker isn't running                                      | Run the command `canyonos doctor` prints, or start Docker Desktop; on Linux, `sudo systemctl start docker` |
| `doctor` fails `Docker Compose available`                                        | Docker is too old to include Compose v2                   | Update Docker, then run `canyonos doctor` again                                                            |
| `doctor` passes but `deploy` can't reach Docker                                  | The terminals use different Docker contexts               | Run `docker context show` in both, switch with `docker context use <name>`, then deploy again              |

## `canyonos deploy` stops before building

The deploy checks the workflow config and your code first and stops on the first
problem, before any image is built.

| Message                                                                | Likely cause                                                      | Fix                                                                                             |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| ``No <path>/workflow_config.yaml here. Run `canyonos convert` first``  | The command ran outside the workflow folder                       | `cd` to the folder that holds `config/` or `.canyon/`; see [Workflow layout](BUILD_ARTIFACT.md) |
| ``Deploy stopped: fix the project errors `canyonos validate` reports`` | The code breaks the runtime contract                              | Fix each `CANYON-*` finding printed above it, then run `canyonos validate` until it passes      |
| `... already claims it (names are lowercased into one image tag)`      | Two agent names differ only in case                               | Rename one                                                                                      |
| `is required because provider is 'ec2-pool'` (or `'ec2-assign'`)       | The provider's settings block is missing                          | Add it; see [EC2 deployment](EC2.md)                                                            |
| `must give every agent a value`                                        | `ec2-assign.machine_type` leaves out an agent                     | Add a machine type for every agent                                                              |
| `expected an integer >= 1` on `replicas`                               | `replicas` is text or zero                                        | Use a whole number, 1 or more                                                                   |
| `is not a single PEP 508 requirement`                                  | A `requirements` item holds several packages or a pip flag        | Put one package per item, such as `pandas==2.2.3`                                               |
| `is not built from builtin types`                                      | An argument or `returns` type uses a typing name like `List[str]` | Use builtins: `list[str]`, `int \| None`                                                        |
| `would shadow the builtin type`                                        | A function is named after a builtin type, such as `list`          | Rename the function and the method                                                              |
| `is reserved for Python`                                               | A function has a dunder name, such as `__init__`                  | Rename the function and the method                                                              |
| `is already a function of this agent`                                  | Two functions of one agent share a name                           | Remove or rename one                                                                            |
| `database: is no longer used`                                          | The retired top-level `database` key is still there               | Remove it; telemetry is set under `otel:`                                                       |

[Workflow config](WORKFLOW_CONFIG.md) lists every setting the schema accepts.

## The deploy fails while building or starting

| Symptom                                                                   | Likely cause                                                                                                       | Fix                                                                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `<Agent> currently requires protobuf<5, but CanyonOS only supports ...`   | A requirement pins a base package below the platform's floor                                                       | Raise or remove the pin; see [Per-image requirements](WORKFLOW_CONFIG.md#per-image-requirements)           |
| `... was not found in the package registry` in the image build            | A `requirements` item uses the import name, not the PyPI name                                                      | Use the PyPI name: `PyYAML` for `import yaml`, `opencv-python` for `import cv2`                            |
| `Deploy failed: generated grpc_stubs are missing or not importable`       | The generated modules don't import in the controller                                                               | Run `canyonos deploy` again                                                                                |
| ``config/policy.yaml must be a mapping with a `rules:` list of mappings`` | `policy.yaml` is empty or malformed                                                                                | Fix it, or delete it to allow everything; see [Policy](RUNTIME_CONTRACT.md#policy)                         |
| `Port ... is already in use`                                              | The endpoint's `api_port`, `redis.port` or a database's `db_port` is taken, often by a deploy that was killed      | Run `canyonos stop`, or `canyonos stop --all` for every workflow; otherwise free the port or change it     |
| `Redis is still running, but its password file ... is gone`               | `~/.canyonos/projects/<project>/redis_password` was deleted while the workflow's Redis kept running                | Remove the old Redis as the message says, with `canyonos stop <project>` or `docker rm`, then deploy again |
| `refuses this project's password` in the deploy output or `canyonos logs` | The password file no longer matches the Redis the Global Controller found running, often one a crashed deploy left | Run `canyonos stop <project>` to remove the old Redis, then deploy again                                   |
| Deploy fails and prints `--- begin container log`                         | An agent's import or constructor raised                                                                            | Read the lines between the markers, then find the error in the next section                                |

## An agent fails to start

These show in the container log `canyonos deploy` prints, or in `canyonos logs <agent>`.

| Symptom                                                                  | Likely cause                                                                                                            | Fix                                                                                                                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `ModuleNotFoundError` for a module of your app                           | The workflow root isn't the import root, so the import doesn't resolve from `/app`                                      | Make the workflow root the folder your imports start from; see [Images and dependencies](IMAGES_AND_DEPENDENCIES.md#what-app-can-import) |
| `ModuleNotFoundError` for a third-party package                          | It is missing from this entry's `requirements`. Your app's `requirements.txt` is never installed                        | Add it to the entry's `requirements`                                                                                                     |
| `ModuleNotFoundError` for a package this agent's code never imports      | The entrypoint's package `__init__.py` or a sibling module imports it, and ships in this image                          | Add it to this entry's `requirements` too                                                                                                |
| `ModuleNotFoundError` for a submodule that used to exist                 | An unpinned requirement resolved to a newer major version than your code was written for                                | Pin the version your app uses                                                                                                            |
| `ImportError` for a name from another agent's module                     | That agent's package `__init__.py` re-exports from its entrypoint, which is a stub here (`CANYON-PACKAGE-REEXPORT`)     | Remove the re-export from that `__init__.py` and import the name from its own module                                                     |
| `attempted relative import with no known parent package`                 | The entrypoint is loaded as a top-level module                                                                          | Make the entrypoint's own imports absolute                                                                                               |
| `SyntaxError` on an import of an agent                                   | An entrypoint path segment isn't a Python identifier, such as `06_agent.py`                                             | Rename the file or folder                                                                                                                |
| A file of your app is missing                                            | It is hidden, a symlink, private key material, under `config/`, or a reserved name; the build printed a note or warning | Move it; see [What the copy includes](IMAGES_AND_DEPENDENCIES.md#what-the-copy-includes)                                                 |
| A module of your app vanished or changed                                 | It has the name of a runtime module, such as `future.py`, and was replaced (`CANYON-FLAT-COLLISION`)                    | Rename it or move it into a package                                                                                                      |
| Missing credentials while the agent loads                                | There is no `.env` beside the workflow, or the code reads another variable name                                         | Add the key to `.env`; see [What `.env` is for](BUILD_ARTIFACT.md#what-env-is-for)                                                       |
| Connection refused to `localhost` for Redis, Postgres or another service | Inside a container, `localhost` is the container itself                                                                 | Use `CANYONOS_REDIS_HOST`, `CANYONOS_REDIS_PORT` and `CANYONOS_REDIS_PASSWORD`, or the database entry's address                          |
| `NOAUTH Authentication required` from Redis                              | The client connects without the workflow's Redis password                                                               | Pass it `CANYONOS_REDIS_PASSWORD`                                                                                                        |
| A model call runs at container start, before any request                 | Module-level code in the entrypoint does real work                                                                      | Move it into a method                                                                                                                    |

## `canyonos test` fails

When `canyonos test` fails, it prints the end of the Global Controller's log and leaves
the deploy running so you can look at it. Find the failing agent and its error, then
look the error up in the tables on this page:

```bash
canyonos status          # which agents are up
canyonos logs MyAgent    # the failing agent's log
canyonos stop            # take the deploy down when you're done
```

A passing test takes everything down itself. On Kubernetes, `canyonos test` queries the
workflow already deployed there and deploys nothing.

## The endpoint rejects the request

| Answer                                                                     | Likely cause                                      | Fix                                                             |
| -------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------- |
| `404 Not found; this endpoint serves POST /<method>`                       | The request went to another path                  | Post to `/<method>`, the `method` in the `endpoint:` block      |
| `405 Method not allowed`                                                   | The request used `GET` or another method          | Use `POST`                                                      |
| `400 Invalid JSON in request body` or `Request body must be a JSON object` | The body isn't a JSON object                      | Send a JSON object with `Content-Type: application/json`        |
| `400 Missing argument(s) ...`                                              | The body leaves out a declared argument           | Send every argument the message lists                           |
| `400 _context must be a JSON object`                                       | `_context` is text or a list                      | Send it as an object, such as `{"tenant": "acme"}`              |
| `403` with an `error_name`                                                 | Policy or a governance rule refused the request   | See [Refusals](RUNTIME_CONTRACT.md#refusals)                    |
| `409 Request ... is not waiting for input`                                 | `POST /answer` came when no question was waiting  | Check that `GET /status` says `input_required` before answering |
| `404 Request not found` from `GET /status`                                 | The `request_id` is wrong, or from another deploy | Use the `request_id` the `POST` returned                        |

## The request fails or returns the wrong result

| Symptom                                                         | Likely cause                                                                                                                                                    | Fix                                                                                                                                         |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `unexpected keyword argument` in the agent                      | An argument name in `functions` differs from the method's parameter name                                                                                        | Make the names match, then run `canyonos validate`                                                                                          |
| `unexpected keyword argument` inside an SDK call                | The installed package is newer than your code expects                                                                                                           | Pin the version your app uses                                                                                                               |
| `missing ... required positional argument`                      | `functions` doesn't declare a parameter the method requires                                                                                                     | Declare it in `functions`, or give the parameter a default                                                                                  |
| `PolicyDenied: Policy denied the call to ...`                   | No `policy.yaml` rule allows that agent for this request's `_context`                                                                                           | Add the agent to the matching rule's `access`; see [Policy](RUNTIME_CONTRACT.md#policy)                                                     |
| `DependencyDown` or `SpendLimit`                                | A governance rule refused the call                                                                                                                              | Check the agent on the dashboard's **Governance** page; see [Refusals](RUNTIME_CONTRACT.md#refusals)                                        |
| `its return value can't be converted to JSON`                   | The method returned framework objects                                                                                                                           | Convert the result to plain types first                                                                                                     |
| The result holds `<...Future object at 0x...>`                  | The code that used it isn't rewritten: a module that imports no agent but calls one it was handed, a `# canyonos: no-rewrite` file, or `CANYONOS_LAZY_VALUES=0` | Call `.value()` there, or import the agent's class in that module; see [Results of agent calls](RUNTIME_CONTRACT.md#results-of-agent-calls) |
| A result is text that looks like a dict                         | `.value()` always returns the stored text, and so does a function with no `returns` type                                                                        | Use the result without `.value()`, and declare `returns` in `functions`                                                                     |
| The result is a coroutine's `repr`                              | The agent method is `async def` (`CANYON-ADAPTER-ASYNC`)                                                                                                        | Make it synchronous, and run any async code inside it                                                                                       |
| Fan-out is no faster than calling one at a time                 | Each call's result is used before the next call is made, as in a generator such as `sum(agent.count(x=x) for x in items)`                                       | Make every call first, in a list, then use the results; see [Results of agent calls](RUNTIME_CONTRACT.md#results-of-agent-calls)            |
| `Lock is bound to a different event loop` on the second request | The agent runs `asyncio.run` per call while the instance holds loop-bound state                                                                                 | Keep one event loop for the instance                                                                                                        |
| Wrong results under load                                        | Concurrent calls share one instance, and state on `self` isn't thread-safe                                                                                      | Make it thread-safe, or set `replicas: 1` and `stateful: true`                                                                              |
| An agent runs inside the caller's process                       | The caller imported the class from a module that is neither the agent's `entrypoint` path nor its basename                                                      | Import it by its `entrypoint` path                                                                                                          |
| Calls meant for one agent reach another                         | Two entries share an `entrypoint`, or two entrypoints share a basename, so one stub replaced the other                                                          | Give each agent its own file name                                                                                                           |
| A model call reaches the provider directly                      | The call isn't OpenAI-format, Anthropic or Bedrock, goes over HTTPS to a host the gateway doesn't know, or the client ignores the proxy variables               | See [Code that bypasses the gateway](LLM_GATEWAY.md#code-that-bypasses-the-gateway)                                                         |
| `TimeoutError` while an agent waits for an answer               | Nobody answered the question within an hour                                                                                                                     | Answer at `POST /answer/<request_id>` sooner; see [Asking the person](RUNTIME_CONTRACT.md#asking-the-person)                                |

## Dashboard

| Symptom                                                         | Likely cause                                                                        | Fix                                              |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------ |
| The dashboard shows `canyonos.redis_auth_failed` for a workflow | The Redis password the dashboard holds for the workflow no longer matches its Redis | Deploy the workflow again, so it registers again |

## Stopping and cleaning

| Symptom                                                         | Likely cause                                                                                                             | Fix                                                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Ctrl+C left the deploy running                                  | Once the deploy is up, Ctrl+C only stops the log output                                                                  | Run `canyonos stop`                                                                          |
| `canyonos clean` deleted `.canyon`                              | That is what `clean` does, along with the agents' images and the workflow's records in `~/.canyonos/projects/<project>/` | Run `canyonos convert` again. To keep a converted workflow, commit `.canyon` before cleaning |
| `canyonos clean` left `~/.canyonos/projects/<project>/`         | The stop failed or was refused, so nothing was cleaned                                                                   | Fix what the stop reported, or name the workflow to force it, and run `clean` again          |
| EC2 machines remain after `canyonos stop`                       | The stop waits up to four minutes for them, then moves on                                                                | See [EC2 deployment](EC2.md)                                                                 |
| Images remain after `canyonos clean`                            | Docker was unreachable, or the images are in another Docker context than the one the deploy used                         | List them with `docker images 'canyonos-*'` and remove them with `docker image rm`           |
| Containers, volumes or images remain after uninstalling the CLI | `canyonos clean --all` wasn't run first                                                                                  | Remove them by hand, below                                                                   |

### Cleaning up after the CLI is already uninstalled

`canyonos clean --all` removes everything CanyonOS put on the machine, so run it before
uninstalling. Without the CLI, do the same by hand. `~/.canyonos/projects` has a folder
for each workflow CanyonOS deployed, and each workflow's containers, volumes and
network carry the label `com.docker.compose.project=canyonos-<project>`.

First list what will be removed:

```bash
for p in $(ls ~/.canyonos/projects); do
  docker ps -a --filter "label=com.docker.compose.project=canyonos-$p" --format '{{.Names}}'
  docker volume ls --filter "label=com.docker.compose.project=canyonos-$p" --format '{{.Name}}'
  docker network ls --filter "label=com.docker.compose.project=canyonos-$p" --format '{{.Name}}'
done
```

Then remove them, along with the dashboard, the networks and CanyonOS's records:

```bash
for p in $(ls ~/.canyonos/projects); do
  label="label=com.docker.compose.project=canyonos-$p"
  docker ps -aq --filter "$label" | xargs docker rm -f -v
  docker volume ls -q --filter "$label" | xargs docker volume rm
  docker network ls -q --filter "$label" | xargs docker network rm
done
docker compose -p canyonos-dashboard down --volumes
docker network rm canyonos-local   # shared by every workflow before each got its own
rm -rf ~/.canyonos
docker images 'canyonos-*'   # then `docker image rm` the ones CanyonOS built or pulled
```
