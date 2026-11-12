# Workflow design

An agentic app is usually a handful of agents and one loop. On CanyonOS you write it in
plain Python: **a workflow is a program that delivers an outcome, and each agent is a
specialist it trusts with one step.**

## Write agents in plain Python

One file per agent, readable top to bottom. Agents call each other with plain function
calls: no SDK, no decorators, no graph to define. Your code says what the workflow does;
the `config` folder says how it runs.

## Scale one agent, not the whole app

Each agent has its own image, `requirements`, `resources` and `replicas`. Give a job its
own agent when it needs:

- a GPU, or much more memory than the rest
- more replicas than the rest
- packages the rest don't need, or that clash with theirs
- state in memory, so fewer replicas than the rest

Every agent is another image to build, and every call between agents crosses the
network, so split only when it buys you something. All agents share one `.env`.

## Start a new workflow

`canyonos new-app` writes a starter workflow;
[Build a workflow from scratch](FROM_SCRATCH.md) walks through it.

## Bring an existing project

The optional helper, `canyonos convert`, uses your own coding agent to convert a copy of
a LangChain or LangGraph project into `.canyon/` for you to check. See
[What a workflow needs](WORKFLOW_REQUIREMENTS.md) and
[Convert an existing workflow](CONVERT_WORKFLOW.md).

## Reserved names

CanyonOS uses these names itself. Don't use them for your own files, folders or agents.

| Name                                                          | Where                    | Why                                                                                                                                                           |
| ------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config/`                                                     | Top of the workflow root | Holds the workflow config and the other config files. It never reaches an agent image.                                                                        |
| `stubs/`, `grpc_stubs/`, `docker_container/`                  | Top of the workflow root | The build writes them in the Global Controller's copy of the root. Yours never reach an agent image.                                                          |
| `Dockerfile`, `requirements.txt`                              | Top of the workflow root | The build writes its own. Yours are left out of the image with a warning.                                                                                     |
| The platform's runtime modules, such as `local_controller.py` | Top of the workflow root | The build overwrites them, and `canyonos validate` reports `CANYON-FLAT-COLLISION`. [The full list](IMAGES_AND_DEPENDENCIES.md#what-the-build-writes-on-top). |
| `endpoint`, in any casing                                     | An agent's `name`        | The HTTP endpoint's container uses it, so the workflow config fails validation.                                                                               |

The conversion skill stops at a top-level `config/`, `stubs/`, `grpc_stubs/` or
`docker_container/` folder: rename it, or approve the rename when the coding agent asks.
