<p align="center">
  <img src="https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/.github/canyonos-banner.gif" alt="CanyonOS" width="720" height="123">
</p>

<p align="center">
  <a href="https://github.com/CanyonCodeCoreAI/canyonos/actions/workflows/ci.yml"><img src="https://github.com/CanyonCodeCoreAI/canyonos/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://github.com/CanyonCodeCoreAI/canyonos/releases"><img src="https://img.shields.io/github/v/release/CanyonCodeCoreAI/canyonos?filter=cli-v*&sort=semver&label=release" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/python-3.10%2B-blue" alt="Python 3.10+">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License: AGPL-3.0"></a>
</p>

## Run agents fast

CanyonOS is a control plane that takes your agentic workflow and deploys it, providing observability and managing distributed deployment.  Maintained by [Canyon Code](https://canyoncode.ai/).

## Why CanyonOS

| | Without CanyonOS | With CanyonOS |
|---|---|---|
| Orchestration | Set up Kubernetes or Docker Compose | `canyonos deploy` |
| Observability | Add Langfuse or Arize Phoenix | Built in, exports OTel anywhere |
| Async execution | Add Ray or KubeRay | Built in, no code changes |

Three systems replaced by one install.

## Core Features
- **Easy deployment**: Developers write agents in python as if writing completely localized code. CanyonOS takes care of distributed deployment of agents and workflows.
- **Complete Observability**: All metrics, logs, and traces from your runtime are collected and displayed, with OTel-compatability allowing connection to any OTel-compatable frontend
- **Fully Asynchronous**: Asynchronous execution built in, without any user workflow modification.
- **Non-invasive**: None of your existing code is changed, a new folder (.car) is created when building on top of a existing workflow

---

## Requirements
- [Docker](https://docs.docker.com/desktop/) with Compose v2 — used to manage everything
- Optional: A coding agent in terminal (used only by canyonos build to convert workflow to canyonos compatible format) — [Claude Code CLI](https://code.claude.com/docs/en/overview) or [Codex CLI](https://learn.chatgpt.com/docs/codex/cli#getting-started)

## Installation

Use any of the following package managers to install the canyonos CLI (curl, brew, uv, pip):

```bash
curl -fsSL https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/packages/cli/install.sh | sh
# OR
uv tool install canyonos
```

Run canyonos doctor to verify all prerequisites are set up before your first deploy:

```bash
canyonos doctor
```

---

## Commands

### Essentials

| Command | What it does |
|---|---|
| `build` | Convert your project to CanyonOS format using your coding agent |
| `deploy` | Build images, launch the workflow, start the dashboard |
| `config` | View or edit the project config |

### Utility

| Command | What it does |
|---|---|
| `status` | Show live workflow endpoints |
| `test` | Send a test prompt to the running workflow |
| `logs` | Re-attach to the deploy log stream |
| `serve` | Start the local dashboard separately |
| `stop` | Stop the running workflow, keep the container |
| `quit` | Full teardown — remove the container and workspace |
| `clean` | Remove generated build artifacts |
| `doctor` | Check that your environment is ready |
| `new-app` | Scaffold a new project |
| `-v`, `--version` | Print the installed version |

---

## Usage

See [how CanyonOS is structured](docs/architecture/README.md).

For all steps below, commands should be ran in the directory of your project folder
```bash
cd my-project
```

### 1. Build your project

`canyonos build` installs the CanyonOS skill into your coding agent and launches it with a prompt to convert your project into `.car/` — CanyonOS's deploy-ready format.
As this uses an agent to configure your workflow, it may take a while (2-10 minutes on average).

```bash
canyonos build
```
The agent runs, reads your code, and produces a `.car/` folder. When it's done, exit back into the terminal, you're now ready to deploy.
The agent will also periodically ask questions to configure your deployment file for you. If you want to change configuration details afterwards, go to step 5. If the config suits your taste, continue.

### 2. Test

Verify the workflow works by deploying everything locally and sending test queries:

```bash
canyonos test {input query}
```

For CI, use `--json` to get a single result object and exit with a non-zero code on failure:

```bash
canyonos test "Hello World!" --json
```

### 3. Deploy

<details>
<summary>Supported dependency versions</summary>

We use the following 3 libraries for CanyonOS, and require a minimum version number if your code also uses these.

If your code imports any of these, it must allow this version or newer. Older isn't supported, sorry!

`grpcio>=1.76.0` · `protobuf>=6.31.1` · `redis>=3.5`

</details>

Deploy the project fully, configured by the config files.
On deploy success, a `POST` endpoint will be returned, in which you can send your workflow queries to.

For deploying on different providers, look at [Providers](packages/core/canyonos_core/reconciler/providers/)

```bash
canyonos deploy
```

Example Success Message:
```
 ┌─ Deploy is live ─────────────────────────────────┐
 │  Dashboard   http://localhost:8081               │
 │  POST        http://localhost:8080/main          │
 └──────────────────────────────────────────────────┘
```
- If you forgot any endpoint, type `canyonos status` to get the endpoints
- The dashboard opens automatically. If you want the raw build output instead of the progress summary, add a `-v` flag to the end of canyonos deploy:
- Every `canyonos deploy` automatically tears down any previous workflow too, so you can also just redeploy directly.

### 4. Sending requests to the workflow

Upon running the deploy command, canyonos automatically generates a REST API endpoint for the workflow. 

For verifying the workflow has been deployed fine, run `canyonos test "A test query"` to send a query through the workflow.

For manually sending requests, use the given endpoint to trigger the workflow:

```bash
curl -X POST http://localhost:8080/main \
  -H "Content-Type: application/json" \
  -d '{
    "query": "AAPL"
  }'
```
You should get a `request_id`, this request_id is async, and will be updated with the answer when complete.
To get the result, use:

```bash
curl http://localhost:8080/status/<request_id>
```

### 5. Edit config

```bash
canyonos config
```

Run `canyonos deploy` again to apply your changes.

#### Configuring the Global Controller (in progress)

Edit `.car/config/global_controller.yaml` to list the agents you want to deploy, their `provider`, `replicas`, and resource limits. Add a per-agent `requirements: [pkg, ...]` list for any extra pip packages that agent's code imports — only `grpcio`, `protobuf`, and `redis` are installed by default.

Agents that need API keys read them from environment variables. Point `env_file` at a `.env` file to have CanyonOS inject it into every agent container:

```yaml
# .car/config/global_controller.yaml
env_file: .env
```

For `provider: EC2` agents specifically (AMI/IAM/security group requirements, the `ec2:` config block), see [packages/core/canyonos_core/reconciler/providers](https://github.com/CanyonCodeCoreAI/canyonos/blob/main/packages/core/canyonos_core/reconciler/providers/README.md).

### 6. Stop or quit

```bash
canyonos stop   # stop the workflow, keeps the global controller container and files, but stops all local controllers
canyonos quit   # full teardown — removes everything
```

### Clean generated files

Removes the `.car` folder and all local `canyonos-*` Docker images:

```bash
canyonos clean
```

---

## Dashboard

When running `canyonos deploy`, our dashboard automatically starts on localhost 8081.

`canyonos serve` starts the local dashboard as a separate compose stack. Deploy starts it automatically, but you can also launch it on its own:

```bash
canyonos serve
```

The dashboard shows OTLP traces emitted by your running workflow and is available at `http://127.0.0.1:{dashboard_port}`.
- dashboard_port is automatically 8081, but you can manually configure your own in config

## FAQ

<details>
<summary><b>How is this different from LangGraph Platform, Ray, or Temporal?</b></summary>

LangGraph Platform runs LangGraph apps. CanyonOS runs plain Python agents from any framework. Ray is general-purpose distributed compute; CanyonOS scales and traces agents specifically. Temporal makes long workflows durable; CanyonOS deploys, scales, and observes agent workflows.

</details>

<details>
<summary><b>Why not just use Kubernetes?</b></summary>

Kubernetes runs containers. CanyonOS runs agents: it scales each agent on its request rate or queue length, traces every call across agents, and limits what each agent may spend on LLM calls. It needs only Docker, not a cluster.

</details>

<details>
<summary><b>What problem does it solve that I can't solve today?</b></summary>

Today, taking a multi-agent workflow to production means wiring up orchestration, async execution, and observability yourself. CanyonOS does all three from one `canyonos deploy`, without changing your agent code.

</details>

<details>
<summary><b>Who is it for, and when do I need it?</b></summary>

Teams whose agent workflow works on a laptop and now needs to run across machines, scale under load, and be observable, without building that platform themselves.

</details>

<details>
<summary><b>Why AGPL, and what's the business model?</b></summary>

TODO

</details>

## Roadmap

See [ROADMAP.md](docs/ROADMAP.md) for the work we plan to do next.

## Contributing

We would love to support you if you wanted to contribute to this repo! For help getting started, go to [CONTRIBUTING.md](https://github.com/CanyonCodeCoreAI/canyonos/blob/main/CONTRIBUTING.md).

## Security

If you have found an issue pertaining to the security of CanyonOS, please look at our [SECURITY.md](https://github.com/CanyonCodeCoreAI/canyonos/blob/main/SECURITY.md) page for more info.

## Citation
If you find CanyonOS (Nalar) useful for your research, please cite our paper:
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

## License

This project is licensed under the GNU Affero General Public License v3.0 - see the [LICENSE](https://github.com/CanyonCodeCoreAI/canyonos/blob/main/LICENSE) file for details.
