# Exceptions
## The Sharp Bits of CanyonOS

We currently have areas that are not supported, and will be listing them below. When building your workflow, take heed of these issues.

## What your app needs before porting

You own your app's code, dependencies, data, credentials, outside services, and whether its answers are correct. CanyonOS owns running it, connecting its containers, and routing its model calls. Check your app against each section below before running `canyonos convert`.

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

Put the app's runtime configuration in `.env` in the project folder. CanyonOS passes it to the agent replicas, not to the endpoint; see [Project layout](BUILD_ARTIFACT.md#what-env-is-for).

The source folder cannot have `config`, `stubs`, `grpc_stubs` or `docker_container` at its top level: those names are reserved at the project root, and `canyonos convert` refuses the folder. Rename them first.

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
