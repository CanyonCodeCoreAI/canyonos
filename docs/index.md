<p align="center">
  <img src="https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/.github/canyonos-banner.gif" alt="CanyonOS" width="720" height="123">
</p>

# CanyonOS

CanyonOS is an open source platform for multi-agent applications written in plain
Python. Your agents do the work, with no SDK, no decorators and no tracing code, and
CanyonOS runs everything around them, locally or on your own infrastructure. You
describe how your workflow runs in a [workflow config](guides/CONFIGURE.md) file and run
`canyonos deploy`.

## Core features

<div class="compare-table" markdown>

|                 | With CanyonOS                                                                                           | Without CanyonOS                          |
| --------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Orchestration   | One-Click deploy                                                                                        | Set up Kubernetes or other infrastructure |
| Observability   | [Built in](guides/DASHBOARD.md), exports to [OpenTelemetry](guides/WORKFLOW_CONFIG.md#oteldestinations) | Add and wire up an observability platform |
| Async execution | Built in, [each agent scales alone](guides/SCALING.md)                                                  | Add Ray or another scaling framework      |
| Cost            | Per workflow and per agent, within [the limits you set](guides/LLM_GATEWAY.md)                          | Calculations and spreadsheets             |

</div>

[What CanyonOS offers](guides/COMPARISONS.md) has the full list, and what CanyonOS works
with.

## How we think about workflows

**A workflow is a program that delivers an outcome, and each agent is a specialist it
trusts with one step.**

Your project folder is the workflow, and one lead agent receives each request and calls
the others. Each agent is a class in its own file, and one agent calls another as if it
were a local function; CanyonOS carries the call to the other agent's container. Your
code says what the application does, and the config says how it runs: how many
replicas, what resources, which models.

Give each job its own agent, so a busy search agent can grow to ten copies while the
rest stay at one. A few well-chosen agents are easier to run than many small ones.
[Workflow design](guides/WORKFLOW_DESIGN.md) has the full approach.

## Try it

With CanyonOS [installed](INSTALLATION.md), run these in an empty folder:

```bash
canyonos new-app     # writes a one-agent starter workflow
canyonos deploy      # runs it
```

[Start from scratch](guides/FROM_SCRATCH.md) takes it from there, step by step.

## Contribute

CanyonOS is open source under the AGPL-3.0, and the code is on
[GitHub](https://github.com/CanyonCodeCoreAI/canyonos). Issues and pull requests are
welcome. [Contributing](contributing/README.md) covers setting up a checkout, running
the tests and how pull requests are reviewed. CanyonOS is maintained by
[Canyon Code](https://canyoncode.ai/).

## Where to go next

- [How it works](HOW_IT_WORKS.md) explains what runs where when you deploy.
- [Start from scratch](guides/FROM_SCRATCH.md) builds a workflow step by step, and
  [Configure your workflow](guides/CONFIGURE.md) covers what to change next. Have an
  app built with another framework?
  [Convert an existing workflow](guides/CONVERT_WORKFLOW.md).
- [EC2](guides/EC2.md) and [Kubernetes](guides/KUBERNETES.md) cover deploying beyond
  this machine.
- [Upgrading](UPGRADING.md) lists what to change when you move to a new release.
