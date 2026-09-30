# Exceptions
## The Sharp Bits of CanyonOS

We currently have areas that are not supported, and will be listing them below. When building your workflow, take heed of these issues.

Database Scaling: We currently do not support scaling for the `type: database`
Human-in-the-Loop: We do not support cases where the workflow asks the human for guidance
Docker-in-Docker: We do not support cases where the workflow calls docker commands.
- You will need to explicitely program your workflow to run Docker-in-Docker commands rather than ordinary docker.
Agent needs a non-installable package (like git, rust, etc.)
The skill file misses some required dependencies
- The skill file, when building the global_controller.yaml file finds the imports that every agent uses and adds that in the requirements section of the .yaml file, but in some occasions, it forgets to find dependencies that

## What your app needs before porting

You own your app's code, dependencies, data, credentials, outside services, and whether its answers are correct. CanyonOS owns running it, connecting its containers, and routing its model calls. Check your app against each section below before running `canyonos build`.

### 1. A way to call it without a person

Provide a function or class that takes a request and returns a result, with no UI or human input:

```python
class SupportAgent:
    async def ask(self, query: str) -> str:
        return await answer_query(query)
```

The serving path can't depend on:

- `input()` or terminal prompts;
- a microphone, speaker, browser, or desktop UI;
- a person approving an action while the request runs;
- an interactive CLI loop;
- starting another web server instead of exposing the app's logic.

If an action needs confirmation, make that confirmation part of the request or the app's workflow state.

### 2. No Docker inside the app

Agent containers have no Docker daemon and no access to the host's Docker socket, so the app can't start Docker. Move code execution or isolation to a separate sandbox service, or give the app a mode that doesn't need Docker.

Also don't depend on the host machine: no local absolute paths, GPU, or display.

### 3. A supported model provider

The managed LLM path supports the providers the in-container LLM gateway routes, listed in [`packages/core/canyonos_core/llm_gateway/config.py`](https://github.com/CanyonCodeCoreAI/canyonos/blob/main/packages/core/canyonos_core/llm_gateway/config.py) for the CanyonOS version you deploy. Today those are OpenAI, Anthropic, and AWS Bedrock. An app that needs another provider has to move to one of these first.

Secrets come from environment variables or a secret store. Model names and service URLs can have defaults, but must be changeable at runtime:

```python
client = OpenAI(
    api_key=os.environ["OPENAI_API_KEY"],
    base_url=os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
)
model = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
```

Inside CanyonOS, an OpenAI app points at the in-container gateway:

```dotenv
OPENAI_API_KEY=...
OPENAI_BASE_URL=http://127.0.0.1:8081/openai/v1
OPENAI_API_BASE=http://127.0.0.1:8081/openai/v1
OPENAI_MODEL=gpt-4.1-mini
```

Don't hardcode an API key, an account-specific resource ID, or a model that can't be changed, and check that the configured model is still available.

### 4. Dependencies declared in `global_controller.yaml`

Each agent image installs only the CanyonOS base packages plus the `requirements` of that agent's entry in `global_controller.yaml`; the Workflow entry works the same way. The app's own `requirements.txt`, `pyproject.toml`, or lockfile is **not** installed, so each entry's `requirements` must list everything its serving path needs.

The base packages are `BASE_AGENT_REQUIREMENTS` and `BASE_WORKFLOW_REQUIREMENTS` in [`packages/core/canyonos_core/stub_generator.py`](https://github.com/CanyonCodeCoreAI/canyonos/blob/main/packages/core/canyonos_core/stub_generator.py). They're installed in the same Python environment as each entry's `requirements`. `PROTOBUF_FLOOR` is forced, while `TESTED_MAJOR_VERSIONS` caps packages unless an entry asks for a newer version.

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
    type: workflow
    workflow_file: workflow.py
    requirements:
      - httpx==0.28.1
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
