# Installation

## Requirements

- **Must have:** [Docker](https://docs.docker.com/get-docker/) with Compose v2.
- **Optional**, each only for its task:
    - A coding agent (in Terminal), to convert an
      existing workflow.
    - An AWS account, to deploy on [EC2](guides/EC2.md).
    - `kubectl` set to a cluster running the CanyonOS operator, to deploy on
      [Kubernetes](guides/KUBERNETES.md). A local cluster also needs
      [`kind`](https://kind.sigs.k8s.io/docs/user/quick-start/#installation).

## Install

```bash
uv tool install canyonos      # recommended
```

That works on macOS, Linux and Windows, and `canyonos upgrade` can update it later.

### Other ways to install

If you don't use uv, pick one of these instead:

<div class="tabs" markdown>

<div class="tab" data-label="pip" markdown>

Works on any OS with Python 3.10 or newer.

```bash
pip install canyonos
```

</div>

<div class="tab" data-label="Homebrew" markdown>

Works on macOS and Linux.

```bash
brew tap CanyonCodeCoreAI/canyonos https://github.com/CanyonCodeCoreAI/canyonos
brew trust --formula CanyonCodeCoreAI/canyonos/canyonos
brew install canyonos
```

</div>

<div class="tab" data-label="Install script" markdown>

Works on macOS and Linux.

```bash
curl -fsSL https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/packages/cli/install.sh | sh
```

</div>

</div>

## Check the install

```bash
canyonos --version
```

## Check your machine

```bash
canyonos doctor
```

It checks that Docker is installed, that it's running, and that it has Compose v2. If a
check fails, it tells you how to fix it.

## Next

Once `canyonos doctor` passes, [Start from scratch](guides/FROM_SCRATCH.md) builds and
deploys your first workflow, step by step. To bring an app built with another
framework, see [Convert an existing workflow](guides/CONVERT_WORKFLOW.md).

## Upgrade

```bash
canyonos upgrade      # if you installed with uv; otherwise it prints the command to run
```

Read [Upgrading](UPGRADING.md) before you move to a new release.

## Uninstall

```bash
canyonos clean --all          # remove every project and everything CanyonOS added
uv tool uninstall canyonos    # or pip uninstall, brew uninstall
rm ~/.local/bin/canyonos      # if you used the install script
```

`clean --all` asks before it deletes anything; add `-y` to skip the question in a
script.
