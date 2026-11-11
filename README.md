<p align="center">
  <img src="https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/.github/canyonos-banner.gif" alt="CanyonOS" width="720" height="123">
</p>

<p align="center">
  <a href="https://github.com/CanyonCodeCoreAI/canyonos/actions/workflows/ci.yml"><img src="https://github.com/CanyonCodeCoreAI/canyonos/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://github.com/CanyonCodeCoreAI/canyonos/releases"><img src="https://img.shields.io/github/v/release/CanyonCodeCoreAI/canyonos?filter=v0.2.*&sort=semver&label=release" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/python-3.10%2B-blue" alt="Python 3.10+">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License: AGPL-3.0"></a>
</p>

[CanyonOS](https://canyonos.ai) is an open source platform that deploys, observes and scales a multi-agent application written in plain Python, with no SDK, no decorators and no tracing code, locally or on your own infrastructure.

Maintained by [CanyonCode](https://canyoncode.ai/).

## Core Features
- **Easy deployment**: Developers write agents in python locally without any special features. CanyonOS instruments the code to simplify and automate deployment.
- **Complete Observability**: All metrics, logs, and traces from your runtime are collected and displayed, with OTel-compatability allowing connection to any OTel-compatable frontend. A Dashboard is included.
- **Fully Asynchronous**: Asynchronous execution for scale is built in, without modifying your workflow.
- **Non-invasive**: None of your existing code is changed. A new `.canyon` folder is created when building on top of a existing workflow.

## Why CanyonOS is Better

| | *Without* CanyonOS | *With* CanyonOS |
|---|---|---|
| Orchestration | Set up Kubernetes or other infrastructure | `canyonos deploy` does this automatically |
| Observability | Add Langfuse or other observability platforms | Built in, exports OTel anywhere |
| Async Execution | Add Ray or other scaling frameworks | Built in, no code changes |
| Cost Transparency | Difficult calculations and spreadsheets | Out of the box insights per workflow and per agent |

## Requirements
- Python 3+
- [Docker](https://docs.docker.com/desktop/) with Compose v2
- _Optional_: A coding agent of your choice to convert an existing project

## Our Principles

### A workflow is a program that delivers an outcome, and each agent is a specialist it trusts with one step.

>> A **workflow** can be defined as a map or graph of **agents**. You can think of these as a group of distributed programs that accomplish a more complex task through coordinated effort. In CanyonOS, your workflow is represented by your project folder.
> 

Your code says what the application does, and the config says how it runs: how many replicas, what resources, which models.

Each agent completes a specialized job, running and scaling in its own containers. A few well-chosen agents are easier to run than many small ones. See our docs on [workflow design](docs/guides/WORKFLOW_DESIGN.md) for more information.

## Installation
### To install CanyonOS:
```bash
curl -fsSL https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/packages/cli/install.sh | sh
```
or
```bash
uv tool install canyonos
```
or
```bash
pip install canyonos
```

---
### To verify the local installation:

```bash
canyonos doctor
```
---
### To run a quick tutorial and local deployment:

```bash
canyonos quickstart
```

## To build a new workflow:

Create a new directory and run `canyonos new-app`.

```bash
mkdir my-proj
cd my-proj
canyonos new-app
```

Each agent is a class in its own file under `agents/`.

> `agents/my_agent.py`

```python
class MyAgent:
    def run(self, query: str) -> str:
        return f"MyAgent got: {query}"
```

A workflow is also an agent. It receives the requests and calls the others. 

> `agents/workflow.py`:

```python
from agents.my_agent import MyAgent

class Workflow:
    def main(self, query: str = "hello") -> dict:
        return {"answer": MyAgent().run(query=query)}
```

For details on new projects, read: [building a new project](docs/guides/FROM_SCRATCH.md).

For configuration, read: [workflow configuration](docs/guides/WORKFLOW_CONFIG.md).

---
### To convert an existing non-CanyonOS workflow:
For an existing non-cayonOS workflow, run `canyonos convert` in its folder, then test and deploy.
Converting needs a coding agent in your terminal, such as Claude Code, Codex, Gemini CLI
or Cursor CLI; [Convert your own workflow](docs/guides/CONVERT_WORKFLOW.md) lists them
all.

```bash
cd your-workflow
canyonos convert
canyonos test "your query"
canyonos deploy
```

The complete path, including credentials, requests, and cleanup, is in the
[CanyonOS documentation](https://canyonos.readthedocs.io/en/latest/). Start with
[Installation](docs/INSTALLATION.md) or [Start from scratch](docs/guides/FROM_SCRATCH.md).

## Commands

| Command | What it does |
|---|---|
| `deploy` | Build Docker images, launch the workflow, start the dashboard |
| `stop` | Stops the current local deployment |
| `convert` | Optional: convert an existing workflow to CanyonOS format using your coding agent |
| `feedback` | Send feedback to developers | 

See the [full list of CLI commands](docs/guides/CLI.md).

## Documentation

- [How it works](docs/HOW_IT_WORKS.md)
- [All guides](docs/guides/README.md)
- [Architecture](docs/architecture/README.md)
- [Contributing](CONTRIBUTING.md)
- [Roadmap](docs/ROADMAP.md)

## Security and License

Report security issues as described in [SECURITY.md](SECURITY.md). 

CanyonOS is licensed under the [GNU Affero General Public License v3.0](LICENSE).

## Citation

If you find CanyonOS useful for your research, please cite our related paper (Nalar):

```bibtex
@misc{laju2026nalar,
      title={Nalar: An agent serving framework},
      author={Marco Laju and Donghyun Son and Saurabh Agarwal and Nitin Kedia and Myungjin Lee and Jayanth Srinivasa and Aditya Akella},
      year={2026},
      eprint={2601.05109},
      archivePrefix={arXiv},
      primaryClass={cs.DC},
      url={https://arxiv.org/abs/2601.05109},
}
```
