# Exceptions
## The Sharp Bits of CanyonOS

We currently have areas that are not supported, and will be listing them below. When building your workflow, take heed of these issues.

Database Scaling: We currently do not support scaling for the `type: database`
Human-in-the-Loop: only `input()`, LangGraph's `interrupt()`, OpenAI Agents SDK approvals (0.12.1 or later) and `ask_human()` ask the person who sent the request. LangGraph's `interrupt()` in an `async def` node blocks that node's event loop until the person answers.
Docker-in-Docker: We do not support cases where the workflow calls docker commands.
- You will need to explicitely program your workflow to run Docker-in-Docker commands rather than ordinary docker.
Agent needs a non-installable package (like git, rust, etc.)
The skill file misses some required dependencies
- The skill file, when building the global_controller.yaml file finds the imports that every agent uses and adds that in the requirements section of the .yaml file, but in some occasions, it forgets to find dependencies that

Python versions: we only support Python 3.11 and 3.12.

Several projects on one machine: each folder you run `canyonos` from is its own project, with its own Global Controller, containers, images and state. The project name is the folder name, lowercased, with every character other than letters, digits, `_` and `-` turned into `-`, repeated or edge `-` removed, and cut to 24 characters. The name `dashboard` is reserved for the dashboard and becomes `dashboard-project`. Ports are not picked for you: give each project its own `redis.port` and `endpoint.api_port` in `global_controller.yaml`.
- Two folders with the same name in different paths are the same project, so deploying one replaces the other.
- Folder names longer than 24 characters are cut, so two long names that start the same become one project.
- A folder name with no ASCII letters, digits or `_` (for example `日本語`) becomes `default`.
- There is one dashboard per machine. Each project registers with it when `canyonos deploy` or `canyonos serve` finds the project's Global Controller running, and the dashboard api keeps that project's Redis port to read its prompts, scaling and monitoring. This is temporary until the project-key design in CAN-521. A project whose registration failed is missing from the dashboard until `canyonos serve` is run again from its folder. `stop` and `quit` leave the dashboard running while another project's Global Controller is up.
- Names join the project and the agent with `-`, so project `my` with agent `app-worker` and project `my-app` with agent `worker` share the image `canyonos-my-app-worker`, the database volume `canyonos-my-app-worker-data` and the replica name `canyonos-my-app-worker-0`. The image and the volume are overwritten or reused silently; only launching a replica while the other project's replica of that name runs fails, with an error naming both projects. Rename the folder or the agent. The folders `dashboard` and `dashboard-project` are the same project for the same reason.

## What your app needs before porting

You own your app's code, dependencies, data, credentials, outside services, and whether its answers are correct. CanyonOS owns running it, connecting its containers, and routing its model calls. Check your app against each section below before running `canyonos build`.

### 1. A way to call it

Provide a function or class that takes a request and returns a result:

```python
class SupportAgent:
    async def ask(self, query: str) -> str:
        return await answer_query(query)
```

The serving path can't depend on:

- terminal UIs beyond `input()`;
- a microphone, speaker, browser, or desktop UI;
- an interactive CLI loop;
- starting another web server instead of exposing the app's logic.

If an action needs a person's answer while the request runs, `input()`, LangGraph's `interrupt()` and OpenAI Agents SDK approvals ask the person who sent the request ([Runtime contract](RUNTIME_CONTRACT.md#asking-the-person)).

### 2. No Docker inside the app

Agent containers have no Docker daemon and no access to the host's Docker socket, so the app can't start Docker. Move code execution or isolation to a separate sandbox service, or give the app a mode that doesn't need Docker.

Also don't depend on the host machine: no local absolute paths, GPU, or display.

### 3. A supported model provider

The managed LLM path supports the calls the in-container LLM gateway routes: any provider's OpenAI-format API (chat completions or responses), Anthropic, and AWS Bedrock. An app that needs another API has to move to one of these first.

Secrets come from environment variables or a secret store. Model names and service URLs can have defaults, but must be changeable at runtime:

```python
client = OpenAI(
    api_key=os.environ["OPENAI_API_KEY"],
    base_url=os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
)
model = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
```

Inside CanyonOS, an OpenAI-format app needs no base URL change; its calls reach the in-container gateway on their own:

```dotenv
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4.1-mini
```

Don't hardcode an API key, an account-specific resource ID, or a model that can't be changed, and check that the configured model is still available.

### 4. Dependencies declared in `global_controller.yaml`

Each agent image installs only the CanyonOS base packages plus the `requirements` of that agent's entry in `global_controller.yaml`. The app's own `requirements.txt`, `pyproject.toml`, or lockfile is **not** installed, so each entry's `requirements` must list everything its serving path needs.

The base packages are `BASE_AGENT_REQUIREMENTS` in [`packages/core/canyonos_core/stub_generator.py`](https://github.com/CanyonCodeCoreAI/canyonos/blob/main/packages/core/canyonos_core/stub_generator.py). They're installed in the same Python environment as each entry's `requirements`. `PROTOBUF_FLOOR` is forced, while `TESTED_MAJOR_VERSIONS` caps packages unless an entry asks for a newer version.

Each entry's `requirements` must:

- include every package the serving path imports, including required extras;
- keep the exact version the app was tested with for every package the serving path depends on, including dependencies of the SDKs it imports;
- stay compatible with the CanyonOS base packages.

```yaml
agents:
  - name: ResearchAgent
    entrypoint: research_agent.py
    requirements:
      - openai==2.32.0          # transitive, but pinned by the application
      - openai-agents==0.14.5
      - pydantic==2.13.3

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

Copy exact versions from the app's lockfile or pinned `requirements.txt`. If it pins nothing, give each fast-moving package a floor and a cap below its next major version, for example `langchain>=0.3,<1.0`.

Keep installs CPU-only when the app only calls a remote model; large CUDA, GPU, or local-model packages can run the build out of disk. The app must also fit its declared memory and time limits: bound agent loops, retries, model calls, and index building, and declare more resources rather than relying on retries after an out-of-memory error or timeout.

### 5. Services, credentials, and data

CanyonOS doesn't create or configure outside services such as Pinecone, Shopify, Google Calendar, Serper, or Tavily.

Set `env_file` in `global_controller.yaml` to the file with the app's runtime configuration, relative to the repository root (`.env` by default):

```yaml
env_file: .env
```

Don't commit real credentials. For each outside service, document its environment variables, provide the credentials in the deployment environment, and return a clear error when they're missing.

Apps that search or process documents must also make their data available: include a small test dataset, or document how production data is mounted.

### 6. Working before it's ported

Porting doesn't fix bugs in the original app. First check that it installs, imports, and runs in a clean environment:

```bash
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install -r requirements.txt
python3 -m compileall -q -x '/\.venv/' .
python3 -c "from your_package.entrypoint import YourAgent"
```

Then install only the packages declared for each `global_controller.yaml` entry into a fresh environment, and check that `python3 -m pip freeze` shows the same versions as the tested environment for every package the serving path uses.

Run at least one real request with a real model and the same data and tools as production. A successful import alone is not enough.

### 7. Network traffic and the LLM gateway

Every HTTP(S) call from an agent container goes through the LLM gateway's proxy on `127.0.0.1:8082`, which decrypts HTTPS only for known LLM API hosts. That means:

- **Company proxies aren't supported.** CanyonOS sets `HTTPS_PROXY` itself, so a proxy in your `.env` is ignored and calls go out directly. On a network that only allows traffic through a company proxy, every call fails.
- **Calling an LLM host with a pinned certificate, a client certificate (mTLS), or your own CA bundle fails.** The proxy answers those hosts with its own certificate.
- **HTTPS LLM calls to a host the proxy doesn't know aren't caught**, such as a self-hosted vLLM behind HTTPS. Plain-HTTP servers are.
- **Clients that ignore proxy settings skip the gateway**, such as `aiohttp.ClientSession()` without `trust_env=True`. Their LLM calls aren't capped or counted.
- **The app can't listen on ports 8081 or 8082.** The gateway and its proxy use them.
- **If the gateway stops, all outbound calls fail**, not just LLM calls.
- **Large downloads go through the same proxy as LLM calls**, so they can slow each other down.
- **Some OpenAI-compatible APIs reject streamed calls.** The gateway adds `stream_options` to read token usage, which strict APIs refuse (for example Azure OpenAI before api-version `2024-09-01-preview`).
- **A typo in a capped `llms.yaml` model id isn't caught.** Real calls don't match the entry, so they run with no cap.
- **Building an agent image needs network access** to download Python 3.12 and mitmproxy for the gateway.
