# CLI reference

Every `canyonos` command. Run `canyonos <command> --help` for its options. How the CLI works under the hood is in [CLI architecture](../architecture/CLI.md).

## Essentials

| Command | What it does |
|---|---|
| `build` | Convert your project to CanyonOS format using your coding agent |
| `deploy` | Build images, launch the workflow, start the dashboard |
| `config` | View or edit the project config |

## Utility

| Command | What it does |
|---|---|
| `status` | Show live workflow endpoints |
| `test` | Deploy locally and send one test prompt end to end, or send it to the deploy that's already running |
| `logs` | Re-attach to the deploy log stream |
| `serve` | Start the local dashboard separately |
| `stop` | Stop the running workflow, keep the container |
| `quit` | Full teardown — remove the container and workspace |
| `clean` | Remove the generated `.car` folder, the project's CanyonOS skill, the `.env` keys `serve` wrote, and every `canyonos-*` Docker image |
| `validate` | Check a converted `.car` against the CanyonOS contract |
| `doctor` | Check that your environment is ready |
| `new-app` | Scaffold a new project |
| `-v`, `--version` | Print the installed version |
