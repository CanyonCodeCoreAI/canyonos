# canyonos CLI

The `canyonos` command line: port a project, deploy it, and manage the running deploy.

## Install

```bash
uv tool install canyonos
canyonos doctor   # check Docker and Compose are available
```

## Use

Converting an existing workflow? Run `canyonos convert` in its folder first; your coding
agent writes a CanyonOS version of it into a `.canyon/` folder.

```bash
cd your-project
canyonos deploy   # build and launch the workflow, then open the dashboard
canyonos stop     # stop the deploy and remove its containers and files
```

Run `canyonos -h` for every command.

## Develop

Run the CLI from this checkout with `uv run canyonos <command>`. Setup is in
[docs/contributing/DEVELOPMENT.md](../../docs/contributing/DEVELOPMENT.md), and how the CLI
works is in [docs/architecture/CLI.md](../../docs/architecture/CLI.md).
