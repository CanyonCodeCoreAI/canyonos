# Workflow design

Agent frameworks ask you to learn their way of building agents: graphs, nodes, edges,
and a runtime you can't see into. We think that's backwards. **A workflow is a program
that delivers an outcome, and each agent is a specialist it trusts with one step.** Two
pillars shape how we think about workflows: simplicity and modularity.

## Simplicity

On CanyonOS, a workflow is plain Python. Your code calls an agent the way it calls any
other class, and CanyonOS runs each agent in its own containers and carries the calls
between them. There's no graph to declare and no framework to learn.

Everything you might change while the workflow runs lives in one `config` folder, so
your code says what the workflow does and the config says how it runs.

## Modularity

Give a job its own agent when it needs something the rest don't. Each agent gets its
own image, its own `requirements`, `resources` and `replicas`, and scales on its own
load, so a split pays off when one step:

- needs a GPU or much more memory than the others
- takes more replicas than the others to keep up
- installs packages that clash with the rest, or that the rest don't need
- keeps state in memory, so it has to run on fewer replicas than the rest

Split only when it buys you something. Every agent is another image to build and
another set of containers to run, and every call between agents goes over the network.
All agent replicas get the same `.env`, so a split doesn't separate credentials.

## Start from scratch

`canyonos new-app` fills an empty folder with a starter: an `agents` folder with one
agent and a workflow that calls it, and a `config` folder with the workflow config and
the optional files. Only the workflow config, `config/workflow_config.yaml`, is needed
to deploy. It lists your agents, and its `endpoint` block names the agent method that
serves requests.

[Build a workflow from scratch](FROM_SCRATCH.md) walks through the starter step by step,
and [Workflow config](WORKFLOW_CONFIG.md) explains every key.

## Convert an existing workflow

Run `canyonos convert` in the workflow's folder. It installs the
`converting-to-canyonos` skill for your coding agent, which uses it to split your
workflow into agents along the two pillars above. Check first that the workflow meets
[What a workflow needs](WORKFLOW_REQUIREMENTS.md);
[Convert an existing workflow](CONVERT_WORKFLOW.md) has the steps.

Note: This skill file is not fool-proof, the agent can reformat 80% of your workflow,
but the configurations you set in the config folder will still be up to you.

## Reserved names

CanyonOS uses these names itself. Don't use them for your own files, folders or agents.

| Name                                                          | Where                    | Why                                                                                                                                                           |
| ------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config/`                                                     | Top of the workflow root | Holds the workflow config and the other config files. It never reaches an agent image.                                                                        |
| `stubs/`, `grpc_stubs/`, `docker_container/`                  | Top of the workflow root | The build writes them in the Global Controller's copy of the root. Yours never reach an agent image.                                                          |
| `Dockerfile`, `requirements.txt`                              | Top of the workflow root | The build writes its own. Yours are left out of the image with a warning.                                                                                     |
| The platform's runtime modules, such as `local_controller.py` | Top of the workflow root | The build overwrites them, and `canyonos validate` reports `CANYON-FLAT-COLLISION`. [The full list](IMAGES_AND_DEPENDENCIES.md#what-the-build-writes-on-top). |
| `endpoint`, in any case                                       | An agent's `name`        | The HTTP endpoint's container uses it, so the workflow config fails validation.                                                                               |

`canyonos convert` stops when the source folder has a `config/`, `stubs/`,
`grpc_stubs/` or `docker_container/` folder at its top level. The conversion skill
doesn't rename your source on its own: rename the folder, or approve the rename when
the coding agent asks.
