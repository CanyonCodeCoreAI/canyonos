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

| Command | What it does |
|---|---|
| `build` | Convert your project to CanyonOS format using your coding agent |
| `deploy` | Build images, launch the workflow, start the dashboard |

See the [CLI reference](docs/guides/CLI.md) for every command.

---

## Quickstart

See [docs/QUICKSTART.md](docs/QUICKSTART.md).

## FAQ

<details>
<summary><b>How is this different from LangGraph Platform, Ray, or Temporal?</b></summary>

CanyonOS runs plain Python agents from any framework. LangGraph Platform runs LangGraph apps.  Ray is general-purpose distributed compute, but CanyonOS scales and traces agents specifically. Temporal makes long workflows durable but CanyonOS deploys, scales, and observes agent workflows.

</details>

<details>
<summary><b>Why not just use Kubernetes?</b></summary>

Kubernetes manages containers. CanyonOS runs agents in addition to containers. It performs the same actions as K8s, traces every call across agents, and provides prompt. It needs only Docker, not a cluster.

</details>

<details>
<summary><b>What problem does it solve that I can't solve today?</b></summary>

Today, taking a multi-agent workflow to production means wiring up orchestration, async execution, and observability yourself. CanyonOS does all three from one `canyonos deploy`, without changing your agent code.

</details>

<details>
<summary><b>Who is it for, and when do I need it?</b></summary>

Teams whose agent workflow works on a laptop and now needs to run across machines, scale under load, and be observable, without building that platform themselves.

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
