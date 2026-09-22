# Preparing an Agent App for CanyonOS

This guide explains what an agent application should provide before it can be
successfully ported to CanyonOS.

Application developers own the application's source code, dependencies, data, credentials, external services, and business correctness. CanyonOS owns runtime orchestration, container communication, and supported model routing.

## 1. Provide a service-ready application interface

Provide a clear, importable function or class that accepts a request and returns a
result. The application must be able to run without a graphical interface or human
input.

```python
class SupportAgent:
    async def ask(self, query: str) -> str:
        return await answer_query(query)
```

The serving path should not depend on:

- `input()` or terminal prompts;
- a microphone, speaker, browser, or desktop UI;
- a person approving an action while the request is running;
- an interactive CLI loop;
- starting another web server instead of exposing the application logic.

If an action needs confirmation, make that confirmation part of the request or the
application's workflow state.

## 2. Do not require Docker inside the application

Do not start Docker from inside the agent application. CanyonOS agent containers do
not provide a Docker daemon or access to the host Docker socket.

If the application uses Docker for code execution or isolation, move that work to a
separate sandbox service or provide a mode that does not require Docker.

The application should also avoid assumptions about the host machine. Do not depend
on local absolute paths, a GPU, or a display.

## 3. Use a supported model provider

The CanyonOS-managed LLM path currently supports:

- OpenAI;
- Anthropic;
- AWS Bedrock.

Applications that require another model provider must migrate to a supported
provider before they can use the managed LLM path.

Secrets must come from environment variables or a secret store. Model names and
service URLs may have sensible defaults, but they must be overridable at runtime.

```python
client = OpenAI(
    api_key=os.environ["OPENAI_API_KEY"],
    base_url=os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
)
model = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
```

For example, an OpenAI application running in CanyonOS uses the in-container proxy:

```dotenv
OPENAI_API_KEY=...
OPENAI_BASE_URL=http://127.0.0.1:8081/openai/v1
OPENAI_API_BASE=http://127.0.0.1:8081/openai/v1
OPENAI_MODEL=gpt-4.1-mini
```

Do not hardcode an API key, an account-specific resource ID, or a model that cannot be changed. Confirm that the configured model is still available. 

## 4. Keep dependencies compatible with CanyonOS

Each agent image installs only the CanyonOS base packages plus the `requirements`
section of that agent's entry in `global_controller.yaml`. Declare Workflow
dependencies on the Workflow entry in the same way. The application's own
`requirements.txt`, `pyproject.toml`, or lockfile is not installed, so an entry's
`requirements` must describe everything its runtime path needs.

The base image currently requires these shared package versions:

```text
grpcio>=1.83.1
grpcio-tools>=1.76.0
protobuf>=6.33.5
boto3>=1.43.91
requests>=2.34.2
```

These versions may change with a new CanyonOS image. Always use the target image's
published dependency versions as the compatibility baseline.

Each entry's `requirements` must satisfy the runtime requirements of that entry:

- include every distribution imported by the serving path, including required
  optional extras;
- keep the exact version the application was tested with for every distribution
  the serving path depends on, including transitive dependencies of the SDKs it
  imports;
- stay compatible with the base package versions above.

A package that is not imported directly can still decide whether the application
works. If the application pins `openai==2.32.0` and the serving path imports only
`openai-agents`, dropping the `openai` pin lets pip install any version allowed by
`openai-agents` (`openai>=2.26.0,<3`). The image builds and imports cleanly, but
every real model request can fail at runtime.

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

If the application has a lockfile or a pinned `requirements.txt`, copy those exact
versions. If it pins nothing, bound each fast-moving package with a floor and a cap
below its next major version, for example `langchain>=0.3,<1.0`. Test that each
entry's complete dependency set resolves against the CanyonOS base image.

Keep the default installation suitable for a CPU container. Avoid pulling large
CUDA, GPU, or local-model packages when the application only calls a remote model.
Large dependency trees can exhaust build disk space before the application starts.

The application must also fit within its declared memory and time limits. Bound
agent loops, retries, model calls, and index building. If the application needs more
resources, declare that requirement instead of relying on retries after an OOM or
timeout.

## 5. Provide required services, credentials, and data

CanyonOS does not automatically create or configure services such as Pinecone,
Shopify, Google Calendar, Serper, or Tavily.

Set `env_file` in `global_controller.yaml` to the file that contains the runtime
configuration. By default, use `.env` in the repository root:

```yaml
env_file: .env
```

If the file is stored elsewhere, set `env_file` to its path relative to the
repository root. Do not commit real credentials to the repository.

If the application needs an external service:

- document the required environment variables;
- provide the credentials in the deployment environment;
- return a clear error when required configuration is missing.

RAG and file-processing applications must also make their data available. Include a small test dataset or document how the production data is mounted. 

## 6. Verify the original application first

Canyonization does not repair bugs in the original application. Before submitting
an application, verify that it can be installed, imported, and called in a clean
environment.

```bash
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install -r requirements.txt
python3 -m compileall -q .
python3 -c "from your_package.entrypoint import YourAgent"
```

Then install only the packages declared for each `global_controller.yaml` entry
into a fresh environment, and confirm that `python3 -m pip freeze` reports the same
versions as the tested environment for every package the serving path uses.

Run at least one representative request using a real model and the same data and
tools expected in production. A successful import alone is not enough.

