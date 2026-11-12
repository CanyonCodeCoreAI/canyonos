# How it works

A map of CanyonOS: the parts, what each one does, and where to read more. For how each
part works inside, see [Architecture](architecture/README.md).

## The big picture

You run `canyonos deploy` in your workflow's folder. It starts the Global Controller and
the dashboard, and the Global Controller starts everything else: your agents, the
endpoint that takes requests, and Redis to keep track of them. A request comes in
through the endpoint, your agents call each other to answer it, and the dashboard
records every step. On Kubernetes, the CanyonOS operator in the cluster starts these
parts instead; see [Where it runs](#where-it-runs).

The CLI and the dashboard call a deployed workflow a *project*. Its ID is the
`project_id` the first deploy writes into the workflow config.

![canyonos deploy starts the Global Controller, which builds and starts your workflow's agent replicas, sends telemetry to the Dashboard and keeps shared state in Redis. Your app sends a request to the Endpoint, which routes it to Agent A; Agent A calls Agent B, and each agent's LLM Gateway sends its model calls to the model providers.](images/how-it-works.svg)

## The parts

| Part                | What it does                                                                                                      | Read more                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| CLI                 | The `canyonos` commands you run: deploy, test, stop, logs and the rest                                            | [CLI reference](guides/CLI.md)                 |
| Workflow config     | Lists your agents, what each one installs and runs on, and the method the endpoint serves                         | [Configure your workflow](guides/CONFIGURE.md) |
| Global Controller   | Builds an image per agent, starts the agents, and replaces any that fail                                          | [Controller](architecture/CONTROLLER.md)       |
| Agents and replicas | Each agent runs in containers of its own; a replica is one copy, and autoscaling adds or removes copies with load | [Autoscaling](guides/SCALING.md)               |
| Endpoint            | Your workflow's HTTP API                                                                                          | [Endpoint](architecture/ENDPOINT.md)           |
| Local Controller    | Runs in every replica and carries calls between agents                                                            | [Controller](architecture/CONTROLLER.md)       |
| LLM Gateway         | Runs in every replica, takes every model call, records tokens and cost, and applies your limits                   | [LLM Gateway](guides/LLM_GATEWAY.md)           |
| Redis               | Keeps track of the running replicas and the requests in flight                                                    | [Controller](architecture/CONTROLLER.md)       |
| Dashboard           | Shows requests, traces, logs, metrics, prompts and spend.                                                         | [Dashboard](guides/DASHBOARD.md)               |

## Where it runs

| Where                | What runs there                                                                  | Read more                          |
| -------------------- | -------------------------------------------------------------------------------- | ---------------------------------- |
| Locally, with Docker | Everything, by default                                                           | [Local](guides/LOCAL.md)           |
| EC2                  | Your agents, on EC2 machines; the rest stays on the machine that runs the deploy | [EC2](guides/EC2.md)               |
| Kubernetes           | Everything, in its own namespace, run by the CanyonOS operator                   | [Kubernetes](guides/KUBERNETES.md) |

## Next

- Build a workflow [from scratch](guides/FROM_SCRATCH.md), or
  [convert your own](guides/CONVERT_WORKFLOW.md).
- See [What CanyonOS offers](guides/COMPARISONS.md) for what it covers and works with.
