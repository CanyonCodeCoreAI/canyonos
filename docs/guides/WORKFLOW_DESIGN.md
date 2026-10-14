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

`canyonos new-app` sets up an empty project in the current folder: an empty `agents` folder, an empty `.env`, and a `config` folder with empty `global_controller.yaml` and `policy.yaml` files.

Only `global_controller.yaml` is needed to deploy, and it has to list at least one agent and the `endpoint` block that serves one of its methods. [global_controller.yaml](GLOBAL_CONTROLLER.md#a-small-example) has a minimal example to start from.

## Converting a existing workflow

When converting an existing workflow, we have a skill file that any agent can download, `porting-to-canyonos` that gives an agent the tools and context needed to initally break up your project according to our 2 pillars.

Note: This skill file is not fool-proof, the agent can reformat 80% of your workflow, but the configurations you set in the config folder will still be up to you.