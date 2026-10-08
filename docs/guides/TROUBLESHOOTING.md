# Troubleshooting

Find the symptom, check the cause against your `.car`, then read the linked
page for the mechanism. `canyonos validate` catches most of the first two
tables before a deploy; its codes are listed in [Images and
dependencies](IMAGES_AND_DEPENDENCIES.md#what-canyonos-validate-checks).

## The deploy is rejected before anything is built

| Symptom | Likely cause |
|---|---|
| `Config file not found: .car/config/global_controller.yaml` | The command ran in a directory without that file. `canyonos deploy` looks for `.car` in the current directory. |
| `the project source directory .car/app does not exist` | `.car/app` was never created, or the command ran from the wrong directory |
| `no agent declaration ... sets agent.name` | An agent entry has no yaml in `.car/config` whose `agent.name` matches it |
| `duplicate service name ... (names are lowercased into one image tag)` | Two entries differ only in case |
| `is required when provider is 'EC2'` | An EC2 entry has no `instance_type` |
| `expected an integer >= 1` on `replicas` | `replicas` is a string or zero |
| `is not a single PEP 508 requirement` | A `requirements` item has several packages or a stray flag |
| `is not built from builtin types` on an argument `type` | A typing name like `List[str]`; use `list[str]` |
| `database: is no longer used` | The retired top-level `database` key is still in the manifest |
| `currently requires protobuf<...` during the build | A requirement pins a base package below the platform floor |
| `Deploy failed: generated grpc_stubs are missing or not importable` | The generated `*_pb2.py` modules do not import in the controller, usually a protobuf runtime mismatch |
| `Port ... already in use` | The workflow `api_port`, a database `db_port` or the Redis port is taken by something else, often a previous deployment that was killed |

A quiet failure also exists: two files in `.car/config` declaring the same
`agent.name`. The last one in sorted filename order wins and nothing warns.
Rename or delete the extra file.

## A container exits or serves nothing

| Symptom | Likely cause |
|---|---|
| Deploy fails and prints `--- begin container log` | The agent's import or constructor raised. Read the lines between the markers. |
| `AttributeError: module ... has no attribute '<Name>'` in that log | The class in the entrypoint is not named like the manifest entry |
| `ModuleNotFoundError` for a module of the application | `.car/app` is not rooted at the import root, so the import does not resolve from `/app`. See [Images and dependencies](IMAGES_AND_DEPENDENCIES.md) |
| `ModuleNotFoundError` for a third-party module | The distribution is missing from this entry's `requirements`. The application's own `requirements.txt` is never installed |
| `ModuleNotFoundError` for a distribution this entry's code never imports | The entrypoint's package `__init__.py` or a sibling module imports it. It ships in this image, so its dependency has to be declared here |
| `ImportError` in a peer container for a name from another agent's module | That agent's package `__init__.py` re-exports from its entrypoint, which is a stub here. `CAR-PACKAGE-REEXPORT` |
| `attempted relative import with no known parent package` | The entrypoint uses relative imports. It is loaded as a top-level module. Make its own imports absolute |
| `SyntaxError` on the workflow's import of an agent | An entrypoint path segment is not a Python identifier |
| A model call runs at container start, before any request | Module-level code in the entrypoint or workflow performs a real run |
| An agent runs inside the workflow process instead of its container | The workflow imported the class from a module that is not the agent's `entrypoint` path or its basename at the root. `CAR-WORKFLOW-STUB-IMPORT` |
| Calls meant for one agent reach another | Two entries share an `entrypoint`, or two entrypoints share a basename, so one stub overwrote the other |
| A module of the application vanished or changed | Its name at the root of the copy matches a platform runtime module (`future.py`, `deploy.py`, `local_controller.py`, ...) and was overwritten. `CAR-FLAT-COLLISION` |
| A file of the application is missing from the image | It is hidden, a symlink, private key material, or one of the reserved root names. The build printed a note or warning about it |
| `import local_controller` fails on a protobuf version check | The image resolved a protobuf below what the generated modules need. Check the requirement that dragged it down |
| Missing credentials while the agent loads | `env_file` is unset, points elsewhere, or the code reads a different variable name |
| Connection refused to `localhost` for Redis, Postgres or another backing service | The client kept the source's `localhost` default. Inside a container that is its own loopback. Use `CANYONOS_REDIS_HOST` and `CANYONOS_REDIS_PORT`, or the database entry's address |
| `ModuleNotFoundError` for a submodule that used to exist | An unpinned requirement resolved to a newer major than the source was written for |
| `unexpected keyword argument` inside an SDK call | The installed distribution is newer than the source expects |

## The request is accepted, then fails

| Symptom | Likely cause |
|---|---|
| `unexpected keyword argument` in the agent | The yaml argument name differs from the method's parameter name |
| `missing ... required positional argument` | The yaml does not declare a parameter the method requires, or the caller did not send it |
| `Unauthorized: Policy denied access to service` | The first matching policy rule, or no rule at all, excludes that service |
| `.value()` returns text that looks like a dict | Expected. Results travel as strings; `json.loads` it |
| `returned a result that cannot be sent as JSON` | The workflow returned framework objects. Convert to plain types first |
| The response holds `<...Future object at 0x...>` | `main` formatted a `Future` (`str`, f-string, `json.dumps`) before resolving it. Call `.value()` first |
| Redis holds a coroutine `repr` instead of a result | The agent method is `async def`. `CAR-ADAPTER-ASYNC` |
| Fan-out is no faster than sequential | Dispatch and `.value()` were fused in one comprehension |
| `Lock is bound to a different event loop` on the second request | The agent runs `asyncio.run` per call while the instance holds loop-bound state. Use one persistent loop |
| Wrong results under load | Concurrent calls share one instance; state on `self` is not thread-safe |
| A model call reaches the provider directly | The SDK is not one of the three the gateway routes (Gemini, Cohere, Azure, ...), or the client was built with an explicit `base_url`. See [LLM gateway](LLM_GATEWAY.md) |

## Workflow endpoint

| Symptom | Likely cause |
|---|---|
| `404` while the workflow container is healthy | The route is `/<function name>`; the caller posted to a different path. The managed platform posts to `/main` only |
| `400 Invalid JSON in request body` or `Request body must be a JSON object` | The body is not a JSON object |
| Function argument missing | The body did not carry it. The managed platform sends only `query` |

## `canyonos test` fails

If the test passes, everything is shut down. If it fails, the containers stay up so
you can check `canyonos logs`, or one agent's logs with `docker logs canyonos-<agent>-0`
(e.g. `canyonos-intentagent-0`). Run `canyonos quit` to remove them.

## Stopping and cleaning

| Symptom | Likely cause |
|---|---|
| Ctrl+C left the deployment running | Once `canyonos deploy` is tailing logs, Ctrl+C only stops the tail. Use `canyonos stop` |
| `canyonos clean` deleted `.car/app` and `.car/config` | That is what it does: it removes the whole `.car` and every `canyonos-*` image |
| Containers remain after `canyonos clean` | `clean` never touches containers. Use `canyonos stop` or `canyonos quit` |
| Images remain after `canyonos clean` | Docker was unreachable, or the images live on a different Docker context than the one the deploy used |
| EC2 instances remain after `canyonos stop` | The drain waited 30 seconds and moved on, or provisioning failed before the instance was recorded. See [EC2 deployment](EC2.md) |
