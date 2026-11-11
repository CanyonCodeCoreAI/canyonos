<p align="center">
  <img src="https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/.github/canyonos-banner.gif" alt="CanyonOS" width="720" height="123">
</p>

<p align="center">
  <a href="https://github.com/CanyonCodeCoreAI/canyonos/actions/workflows/ci.yml"><img src="https://github.com/CanyonCodeCoreAI/canyonos/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://github.com/CanyonCodeCoreAI/canyonos/releases"><img src="https://img.shields.io/github/v/release/CanyonCodeCoreAI/canyonos?filter=v0.2.*&sort=semver&label=release" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/python-3.10%2B-blue" alt="Python 3.10+">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License: AGPL-3.0"></a>
</p>

[CanyonOS](https://canyonos.ai) is a control plane that takes your agentic workflow and deploys it,
providing observability and managing distributed deployment. Maintained by
[Canyon Code](https://canyoncode.ai/).

## Why CanyonOS

|                 | Without CanyonOS             | With CanyonOS          |
| --------------- | ---------------------------- | ---------------------- |
| Orchestration   | Docker Compose or Kubernetes | `canyonos deploy`      |
| Observability   | Langfuse or Arize Phoenix    | Built in, exports OTel |
| Async execution | Ray or KubeRay               | Built in               |

Three systems replaced by one install.

## Core features

**A workflow is a program that delivers an outcome, and each agent is a specialist it
trusts with one step.**

Write agents in plain Python and call them as though they are local code.
CanyonOS keeps the code focused on what the application does and uses
configuration to decide how it runs. Split agents when a job needs different
resources, credentials, or scale. Split only when it buys you something. Pieces
for their own sake are just more to manage.

When you convert an existing workflow, CanyonOS writes its generated files under
`.canyon/` and leaves your application source untouched.

## Install

You need Docker with Compose v2. Install the CLI with the macOS/Linux installer
or uv:

```bash
curl -fsSL https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/packages/cli/install.sh | sh
# or
uv tool install canyonos

canyonos doctor
```

On Windows, use `uv tool install canyonos` or `pip install canyonos`.

## Start a workflow

Run the guided first deployment:

```bash
canyonos quickstart
```

For an existing workflow, run `canyonos convert` in its folder, then test and deploy.
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

`canyonos deploy` builds and starts a workflow, then starts the dashboard.
`canyonos convert` prepares an existing workflow with a coding agent. See the
[CLI reference](docs/guides/CLI.md) for every command and option.

## Documentation

- [How it works](docs/HOW_IT_WORKS.md)
- [All guides](docs/guides/README.md)
- [Architecture](docs/architecture/README.md)
- [Contributing](CONTRIBUTING.md)
- [Roadmap](docs/ROADMAP.md)

## Security and license

Report security issues as described in [SECURITY.md](SECURITY.md). CanyonOS is
licensed under the [GNU Affero General Public License v3.0](LICENSE).

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
