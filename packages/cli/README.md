# canyonos CLI

The `canyonos` command line: port a project, deploy it, and manage the running deploy.

## Install

```bash
uv tool install canyonos
canyonos doctor   # check Docker, git and a coding agent are available
```

## Use

```bash
cd your-project
canyonos build    # port the project into a .car/ folder
canyonos deploy   # build and launch the workflow, then open the dashboard
canyonos quit     # stop the deploy and remove its container and files
```

Run `canyonos -h` for every command.

## Develop

Run the CLI from this checkout with `uv run canyonos <command>`. Setup is in
[docs/contributing/DEVELOPMENT.md](../../docs/contributing/DEVELOPMENT.md), and how the CLI
works is in [docs/architecture/CLI.md](../../docs/architecture/CLI.md).
