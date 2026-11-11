# Configure your workflow

Your code says what the workflow does, and the files in its `config` folder say how it
runs. `canyonos new-app` creates it with `workflow_config.yaml`; `llms.yaml`,
`prompts.yaml` and `scaling.yaml` with their examples commented out; and a
`policy.yaml` that lets every request reach every agent. After `canyonos convert`, the
folder is `.canyon/config`.

| File                    | What it sets                                                                                         | Details                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `workflow_config.yaml`  | The agents, their functions and packages, replicas, CPU, memory and GPU, the endpoint, where it runs | [Workflow config](WORKFLOW_CONFIG.md)                    |
| `llms.yaml`             | Which models each agent may call, and the most one call may cost                                     | [LLM Gateway](LLM_GATEWAY.md)                            |
| `prompts.yaml`          | The system prompt of each agent function, with versions                                              | [Prompt management](PROMPTS.md)                          |
| `scaling.yaml`          | When to add and remove replicas                                                                      | [Autoscaling](SCALING.md)                                |
| `policy.yaml`           | Which agents a request may reach                                                                     | [Policy](RUNTIME_CONTRACT.md#policy)                     |
| `governance.yaml`       | Per agent: refuse calls while an agent it needs is down, and switch model or refuse past a spend     | [Governance rules](RUNTIME_CONTRACT.md#governance-rules) |
| `.env`, beside `config` | API keys and other secrets                                                                           | [What `.env` is for](BUILD_ARTIFACT.md#what-env-is-for)  |

## Apply a change

| You changed               | Run                                                      |
| ------------------------- | -------------------------------------------------------- |
| Settings, in the terminal | `canyonos config`; it applies them to the running deploy |
| A file in `config/`       | `canyonos sync`                                          |
| Your code or `.env`       | `canyonos deploy`                                        |

`canyonos config` and `canyonos sync` apply to a deploy on Docker; on Kubernetes, run
`canyonos deploy` again. With nothing deployed, every change applies on the next
`canyonos deploy`. Prompts, scaling and spend rules can also be changed on the
[dashboard](DASHBOARD.md) while the workflow runs.

## Give an agent more

More copies handle more requests at once; more CPU and memory make each copy faster.
In the agent's entry in the workflow config:

```yaml
  - name: MyAgent
    entrypoint: agents/my_agent.py
    replicas: 2
    resources:
      cpu: 2          # cores, default 1
      memory: 1024    # MB, default 512
```

Add `gpu: 1` under `resources` for an agent that needs a GPU.

On Docker, `canyonos deploy` also shows these per agent before it starts, so you can
change them there.

## Limit what a model call costs

In `llms.yaml`, list a model and the agents that may call it, each with the most one
call may cost in US dollars:

```yaml
haiku:
  model_id: us.anthropic.claude-haiku-4-5-20251001-v1:0
  max_tokens: 1024
  agents:
    MyAgent: 0.01
```

Once a model is listed with `agents`, only those agents may call it. A model that isn't
listed stays open to every agent. See [LLM Gateway](LLM_GATEWAY.md).

## Scale with load

In `scaling.yaml`:

```yaml
scaling:
  min_replicas: 1
  max_replicas: 4
  metric: requests_per_minute_per_replica
  scale_up_above: 10
  scale_down_below: 1
```

Each agent is measured on its own load. See [Autoscaling](SCALING.md).

## Run it somewhere else

`provider` in the workflow config decides where the agents run: `local` (Docker on
this machine, the default), or `ec2-pool` and `ec2-assign` for EC2 machines.
`canyonos target kubernetes` moves the whole workflow to a Kubernetes cluster. See
[Local](LOCAL.md), [EC2](EC2.md) and [Kubernetes](KUBERNETES.md).
