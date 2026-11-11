# Contributing

How to work on CanyonOS itself.

## Where to start

Read
[CONTRIBUTING.md](https://github.com/CanyonCodeCoreAI/canyonos/blob/main/CONTRIBUTING.md)
on GitHub first. It covers the repository layout, setup, the checks CI runs, and how
pull requests are reviewed and merged. Then set up a checkout with
[Development](DEVELOPMENT.md).

## Pages

| Page                                 | What it covers                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| [Development](DEVELOPMENT.md)        | Running CanyonOS from a checkout on Docker, EC2 or kind; building the images; the tests |
| [Style](STYLE.md)                    | What the checks enforce, names, file layout, docs and docstrings                        |
| [Configuration internals](CONFIG.md) | How a project's config is loaded, checked and applied, and how to add a setting         |
| [AI policy](AI_POLICY.md)            | How you may use AI tools in a contribution                                              |

## How the parts work

[Architecture](../architecture/README.md) describes each component inside: the
[CLI](../architecture/CLI.md), the [Controller](../architecture/CONTROLLER.md), the
[Reconciler](../architecture/RECONCILER.md), the [Operator](../architecture/OPERATOR.md)
and the rest. For what the parts are and where they run, start with
[How it works](../HOW_IT_WORKS.md).
