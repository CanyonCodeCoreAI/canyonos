# Workflow Design

Agent frameworks ask you to learn their way of building agents: graphs, nodes, edges,
and a runtime you can't see into. We think that's backwards.

**A workflow is a program, and you already know how to write programs.**

Two pillars shape how we think about workflows: simplicity and modularity.

## Simplicity

On CanyonOS, a workflow is plain Python. You call your agents the way you'd call any
other code, and CanyonOS handles state and scaling. There's nothing new to learn, and
nothing in your logic is tied to us.

Everything you might change while your app runs lives in one `config` folder, so your
code says what your app does and your config says how it runs.

## Modularity

Give each job its own agent. One calls a model and needs a GPU, another needs many
copies running at once, another needs its own credentials. Split apart, each can scale
and change on its own without dragging the rest along.

Split only when it buys you something. Pieces for their own sake are just more to
manage.

## From scratch

`canyonos new-app` creates a starter project in an empty folder: an `agents` folder with one agent and a workflow that calls it, and a `config` folder with every config file templated.

Only `global_controller.yaml` is needed to deploy, and it has to list at least one agent and the `endpoint` block that serves one of its methods. The starter's `config/global_controller.yaml` is a working example; [global_controller.yaml](GLOBAL_CONTROLLER.md) explains every key.

The project root reserves four top-level names: `config` holds the manifest, and the build generates `stubs`, `grpc_stubs` and `docker_container` in the Global Controller's copy of the root. Do not use the last three for your own folders, and `canyonos convert` refuses a source folder that has any of the four at its top level; see [Project layout](BUILD_ARTIFACT.md).

## Converting a existing workflow

When converting an existing workflow, we have a skill file that any agent can download, `converting-to-canyonos` that gives an agent the tools and context needed to initally break up your project according to our 2 pillars.

Note: This skill file is not fool-proof, the agent can reformat 80% of your workflow, but the configurations you set in the config folder will still be up to you.