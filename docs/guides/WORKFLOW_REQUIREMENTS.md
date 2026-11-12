# What a workflow needs

Check an existing app against these six requirements before you
[convert it](CONVERT_WORKFLOW.md). You own the app's code, dependencies, data,
credentials, outside services, and whether its answers are correct. CanyonOS owns
running it, connecting its containers, and routing its model calls.

| Requirement                                                                                        | Check                                                                                          |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [1. A way to call it](#1-a-way-to-call-it)                                                         | A function or method takes a request and returns a result, with no UI or interactive loop      |
| [2. No Docker, and nothing from the host](#2-no-docker-and-nothing-from-the-host)                  | The serving path starts no containers and needs no host paths or display                       |
| [3. A supported model provider](#3-a-supported-model-provider)                                     | Model calls use an OpenAI-format API, Anthropic or Bedrock, configured from the environment    |
| [4. Dependencies declared in the workflow config](#4-dependencies-declared-in-the-workflow-config) | Each agent entry's `requirements` lists, with versions, every package its serving path imports |
| [5. Services, credentials, and data](#5-services-credentials-and-data)                             | Every outside service, key and dataset the app uses is available where it runs                 |
| [6. Working before you convert it](#6-working-before-you-convert-it)                               | It installs, imports and answers a real request in a clean environment                         |

## 1. A way to call it

The app has a function or class method that takes a request and returns a result.

```python
import asyncio


class SupportAgent:
    def ask(self, query: str) -> str:
        return asyncio.run(answer_query(query))
```

CanyonOS calls the method synchronously and doesn't await an `async def`, so wrap async
logic with `asyncio.run` as above. The other rules for the class are in
[Agent class](RUNTIME_CONTRACT.md#agent-class).

The serving path can't depend on:

- terminal UIs beyond `input()`
- a microphone, speaker, browser, or desktop UI
- an interactive CLI loop
- starting another web server instead of exposing the app's logic

If an action needs a person's answer while the request runs, `input()`, LangGraph's
`interrupt()` and OpenAI Agents SDK approvals ask the person who sent the request; see
[Asking the person](RUNTIME_CONTRACT.md#asking-the-person).

## 2. No Docker, and nothing from the host

The serving path starts no containers and depends on nothing from the host machine.

Agent containers have no Docker daemon and no access to the host's Docker socket. If
the app runs code in Docker, move that to a separate sandbox service, or give the app a
mode that doesn't need Docker.

Check for local absolute paths and anything that needs a display. Files the app opens
must be inside the workflow root to reach the image; see
[What the copy includes](IMAGES_AND_DEPENDENCIES.md#what-the-copy-includes). An agent
gets a GPU only when its entry asks for one with `resources.gpu`; see
[Workflow config](WORKFLOW_CONFIG.md).

## 3. A supported model provider

The app's model calls use an API the LLM Gateway routes: any provider's OpenAI-format
API, Anthropic, or AWS Bedrock through boto3.

Other model APIs still go out, but the gateway doesn't record, limit or price them, so
an app that uses one has to move to a supported API first.
[Which calls go through it](LLM_GATEWAY.md#which-calls-go-through-it) lists the exact
paths, and [Network limits](LLM_GATEWAY.md#network-limits) the cases it can't catch,
such as a self-hosted model served over HTTPS. For Bedrock, the entry's `requirements`
must install `boto3`.

Keys come from environment variables or a secret store. Model names and service URLs
can have defaults, but must be changeable at run time:

```python
client = OpenAI(
    api_key=os.environ["OPENAI_API_KEY"],
    base_url=os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
)
model = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
```

Inside CanyonOS, an OpenAI-format app needs no base URL change: its calls reach the
gateway in its container on their own. Its `.env` only needs the key and the model:

```dotenv
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4.1-mini
```

Don't hardcode an API key, an account-specific resource ID, or a model that can't be
changed, and check that the configured model is still available.

## 4. Dependencies declared in the workflow config

Each agent entry's `requirements` in the workflow config lists every package its
serving path needs, with the versions the app was tested with.

Each agent image installs only the CanyonOS base packages plus that entry's
`requirements`. The app's own `requirements.txt`, `pyproject.toml` or lockfile is not
installed. The base packages and the versions they allow are in
[Per-image requirements](WORKFLOW_CONFIG.md#per-image-requirements).

Each entry's `requirements` must:

- include every package the serving path imports, including required extras
- keep the exact version the app was tested with for every package the serving path
  depends on, including dependencies of the SDKs it imports
- stay compatible with the CanyonOS base packages

```yaml
agents:
  - name: ResearchAgent
    entrypoint: research_agent.py
    requirements:
      - openai==2.32.0          # transitive, but pinned by the application
      - openai-agents==0.14.5
      - pydantic==2.13.3
    functions:
      - name: research
        arguments:
          - name: query
            type: str

  - name: Workflow
    entrypoint: workflow.py
    requirements:
      - httpx==0.28.1
    functions:
      - name: main
        arguments:
          - name: query
            type: str

endpoint:
  agent: Workflow
  method: main
```

Copy exact versions from the app's lockfile or pinned `requirements.txt`. If it pins
nothing, give each fast-moving package a floor and a cap below its next major version,
for example `langchain>=0.3,<1.0`.

To check an entry, install only the base packages and its `requirements` into a fresh
environment, then check that `python3 -m pip freeze` shows the tested version of every
package the serving path uses. `canyonos validate` installs nothing, so a wrong package
name only fails in the image build.

Keep installs CPU-only when the app only calls a remote model: large CUDA, GPU or
local-model packages can run the build out of disk. Each replica must also fit the
memory its entry declares in `resources.memory`. Bound agent loops, retries, model
calls and index building, and declare more memory rather than relying on retries after
an out-of-memory error.

## 5. Services, credentials, and data

Every outside service, credential and dataset the app uses is available where it runs.

CanyonOS doesn't create or configure outside services such as Pinecone, Shopify, Google
Calendar, Serper or Tavily. For each one:

- document its environment variables
- put the values in `.env`, which CanyonOS passes to the agent replicas but not to the
  endpoint; see [What `.env` is for](BUILD_ARTIFACT.md#what-env-is-for)
- return a clear error when they're missing

Don't commit real credentials.

Calls to outside services leave through the gateway's proxy, so a network that only
allows traffic through a company proxy doesn't work; see
[Network limits](LLM_GATEWAY.md#network-limits).

An app that searches or processes documents must also make its data available: include
a small test dataset, or document how production data is mounted.

## 6. Working before you convert it

The app installs, imports and answers a real request in a clean environment.

Converting doesn't fix bugs in the original app. Check it first:

```bash
python3 -m venv .venv
. .venv/bin/activate          # on Windows: .venv\Scripts\activate
python3 -m pip install -r requirements.txt
python3 -m compileall -q -x '/\.venv/' .
python3 -c "from your_package.entrypoint import YourAgent"
```

Then run at least one real request with a real model and the same data and tools as
production. A successful import alone is not enough.

Last, rename any top-level folder named `config`, `stubs`, `grpc_stubs` or
`docker_container`: the conversion skill stops at one. See
[Reserved names](WORKFLOW_DESIGN.md#reserved-names).
