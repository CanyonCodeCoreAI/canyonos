# Build a workflow from scratch

A CanyonOS workflow has a fixed layout: your agents' code in `agents/`, and how they run
in `config/`. `canyonos new-app` writes that layout with a template for every file, and
this guide fills it in, step by step.

You need CanyonOS [installed](../INSTALLATION.md) and Docker running.

## 1. Create the layout

```bash
mkdir my-workflow
cd my-workflow
canyonos new-app
```

`new-app` only works in an empty folder. It writes:

```text
my-workflow/
├── agents/
│   ├── my_agent.py
│   └── workflow.py
├── config/
│   ├── workflow_config.yaml
│   ├── llms.yaml
│   ├── policy.yaml
│   ├── prompts.yaml
│   └── scaling.yaml
├── .env.example
└── .gitignore
```

| File                          | What it's for                                     | Step                                            |
| ----------------------------- | ------------------------------------------------- | ----------------------------------------------- |
| `agents/*.py`                 | Your agents, one class per file                   | [2](#2-write-your-agents)                       |
| `config/workflow_config.yaml` | The workflow config: your agents and how they run | [3](#3-list-your-agents-in-the-workflow-config) |
| The other files in `config/`  | Models, prompts, scaling and access; all optional | [4](#4-turn-on-what-you-need-optional)          |
| `.env.example`                | The names of the keys your agents need            | [5](#5-add-your-keys)                           |

## 2. Write your agents

Each agent is a class in its own file under `agents/`. The template's
`agents/my_agent.py` shows the shape:

```python
# The class name must match the agent's `name` in config/workflow_config.yaml.
class MyAgent:
    def run(self, query: str) -> str:
        return f"MyAgent got: {query}"
```

One agent receives the requests and calls the others. In the template that is
`agents/workflow.py`:

```python
# The agent the endpoint serves: `POST /main` runs `Workflow.main`.
from agents.my_agent import MyAgent


class Workflow:
    def main(self, query: str = "hello") -> dict:
        return {"answer": MyAgent().run(query=query)}
```

Replace these with your own agents in the same shape. To call another agent, import its
class and call its method with keyword arguments, then use what it returns as you would
any return value. Each call returns at once, so several calls run at the same time,
and CanyonOS waits for a result only at the first line that needs it; see
[Results of agent calls](RUNTIME_CONTRACT.md#results-of-agent-calls).

## 3. List your agents in the workflow config

Every agent needs an entry in `config/workflow_config.yaml`. This one has three
agents: `Workflow` takes the requests and calls `ResearchAgent` and `WriterAgent`. Copy
it and use your own names:

```yaml
target: docker      # where it runs; step 6 changes these two
provider: local

agents:
  - name: Workflow
    entrypoint: agents/workflow.py
    functions:
      - name: main
        arguments:
          - name: query
            type: str
        returns:
          type: dict

  - name: ResearchAgent
    entrypoint: agents/research_agent.py
    requirements:
      - openai
    replicas: 2
    functions:
      - name: research
        arguments:
          - name: topic
            type: str
        returns:
          type: str

  - name: WriterAgent
    entrypoint: agents/writer_agent.py
    requirements:
      - openai
    resources:
      cpu: 2
      memory: 1024
    functions:
      - name: write
        arguments:
          - name: notes
            type: str
        returns:
          type: str

endpoint:
  agent: Workflow
  method: main
```

What each setting does:

| Setting                             | What it does                                                           | Default          |
| ----------------------------------- | ---------------------------------------------------------------------- | ---------------- |
| `name`                              | The agent's name; must equal the class name in its file                | required         |
| `entrypoint`                        | The file that holds the class                                          | required         |
| `functions`                         | The methods others may call, with each argument's type                 | none             |
| `requirements`                      | The Python packages this agent needs, like `openai` or `pandas==2.2.3` | none             |
| `replicas`                          | How many copies of the agent run at once                               | `1`              |
| `resources`                         | `cpu` cores, `memory` in MB and `gpu` count for each copy              | `1`, `512`, none |
| `endpoint.agent`, `endpoint.method` | The method a request runs: `POST /main` runs `Workflow.main`           | required         |

The file keeps this order: `target` and `provider`, then `agents`, then `endpoint`.
Every other setting has a default that suits most workflows;
[Workflow config](WORKFLOW_CONFIG.md) lists them all.

## 4. Turn on what you need (optional)

Each of these files has a commented example. Uncomment the ones you want. Some can also
be changed on the [dashboard](DASHBOARD.md) while the workflow runs:

| File           | Uncomment it to                                            | On the dashboard                                                              | Details                              |
| -------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------ |
| `llms.yaml`    | Limit which models an agent may call and what a call costs | No                                                                            | [LLM Gateway](LLM_GATEWAY.md)        |
| `prompts.yaml` | Keep system prompts outside your code, with versions       | Edit them and make a new version live, once they're in the file               | [Prompt management](PROMPTS.md)      |
| `scaling.yaml` | Add and remove copies of each agent with its load          | Add or change the policy; the next deploy or sync replaces it with the file's | [Autoscaling](SCALING.md)            |
| `policy.yaml`  | Restrict which agents a request may reach                  | No                                                                            | [Policy](RUNTIME_CONTRACT.md#policy) |

The dashboard's **Governance** page also sets spend rules for each agent, such as
refusing calls or switching model above a cost, with no file needed.

## 5. Add your keys

```bash
cp .env.example .env
```

Put the keys your agents read in `.env`, such as `OPENAI_API_KEY=sk-...`. Every agent
gets them as environment variables.

## 6. Choose where it runs

By default the workflow runs locally, on Docker on your machine. `canyonos target` shows
where it deploys. To run it somewhere else, set that up first:

| Where                | What to do                                                                                                                             | Details                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Locally, with Docker | Nothing; it's the default. If you switched to Kubernetes, `canyonos target docker` switches back                                       | [Local](LOCAL.md)           |
| EC2                  | Run `canyonos provision` to create a machine on AWS to deploy from, copy the workflow there, and set `provider` in the workflow config | [EC2](EC2.md)               |
| Kubernetes           | Run `canyonos target kubernetes` to point the workflow at your cluster; `canyonos cluster up` makes a local one to try it              | [Kubernetes](KUBERNETES.md) |

[Where a workflow deploys](LOCAL.md#where-a-workflow-deploys) explains the `target` and
`provider` settings behind these.

The next steps are the same wherever it runs.

## 7. Run it

```bash
canyonos validate              # check the layout and the workflow config
canyonos test "your query"     # deploy locally and send one request
canyonos deploy                # deploy and keep it running
```

`canyonos deploy` first shows each agent's CPU, memory, GPU and replicas; choose default
or edit the configurations. When it's up, send a request:

```bash
curl -X POST http://127.0.0.1:8080/main \
  -H "Content-Type: application/json" \
  -d '{"query": "your query"}'
```

It answers with a `request_id`. Get the result with:

```bash
curl http://127.0.0.1:8080/status/<request_id>
```

### Watch it on the dashboard

The deploy starts the [dashboard](DASHBOARD.md) at `http://127.0.0.1:8081`. Open it to
see each request, the agents it reached, its model calls and their cost. If the
dashboard isn't running, start it on its own:

```bash
canyonos serve
```

## 8. Stop

```bash
canyonos stop     # remove the containers, keep the images for a quick redeploy
canyonos clean    # also remove the agents' images
```

## Next

- [Configure your workflow](CONFIGURE.md): change settings and apply them to a running
  deploy.
- [Dashboard](DASHBOARD.md): find a request and read what each page shows.
