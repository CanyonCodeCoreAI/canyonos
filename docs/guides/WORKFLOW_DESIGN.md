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

We have a command, `canyonos new-app` that creates a basic template of a workflow in the project root.
It creates a blank agents folder, as well as a config folder with the intial config files templated. 

Look at the rest of the markdwn files in this guides folder for help setting up the config folder, only the global_controller.yaml file is needed for deploy.

## Converting a existing workflow

When converting an existing workflow, we have a skill file that any agent can download, `porting-to-canyonos` that gives an agent the tools and context needed to initally break up your project according to our 2 pillars.

Note: This skill file is not fool-proof, the agent can reformat 80% of your workflow, but the configurations you set in the config folder will still be up to you.