# CLI reference

Every `canyonos` command. Run `canyonos <command> --help` for its options. How the CLI works under the hood is in [CLI architecture](../architecture/CLI.md).

## Essentials

| Command | What it does |
|---|---|
| `deploy` | Build images, launch the workflow, start the dashboard |
| `config` | View or edit the project config |

## Utility

| Command | What it does |
|---|---|
| `status` | Show whether a deploy is running, its endpoint, and how to query it |
| `test` | Deploy locally and send one test prompt end to end, or send it to the deploy that's already running |
| `logs` | Re-attach to the deploy log stream |
| `serve` | Start the local dashboard separately |
| `stop` | Stop the running workflow, keep the container |
| `quit` | Full teardown — remove the container and workspace |
| `clean` | Remove the generated `.canyon` folder (and the project id, when `global_controller.yaml` lives there, so the next deploy is a new dashboard project), the project's CanyonOS skill, the `.env` keys `serve` wrote, and the Docker images of the agents in this project's `global_controller.yaml` |
| `convert` | Optional: convert an existing workflow to CanyonOS format using your coding agent |
| `validate` | Check a converted `.canyon` against the CanyonOS contract |
| `doctor` | Check that your environment is ready |
| `new-app` | Create a starter project with one agent in an empty folder |
| `contact` | See or change whether the CLI shares usage reporting with Canyon Code |
| `-v`, `--version` | Print the installed version |

## Usage reporting

Usage reporting is off until you say yes. The CLI asks once, in the terminal, after the first `canyonos deploy` that brings a workflow up; dismissing the question counts as no, and a non-interactive run is never asked. When it is on, each run of `new-app`, `build`, `validate`, `deploy`, `test`, `serve`, `stop`, `clean` or `quit` records one event: the command name, whether it succeeded, when it ran, the CLI version and a random installation id. Arguments, paths, prompts, code, environment variables and credentials are never collected. Events wait in `~/.canyonos/usage/outbox/`, readable only by you, and are sent over HTTPS to Canyon Code's usage API, by a background process started as each `canyonos` command exits, so sending never slows your commands down or changes their output; an event is deleted only once the API has stored it. Run `canyonos contact` to see your choice, `canyonos contact --usage off` to turn it off, which also deletes the unsent events and forgets the installation id, or `canyonos contact --usage on` to turn it on again under a new id. The client code is in [`packages/cli/canyonos/usage/`](../../packages/cli/canyonos/usage/).

Each event holds only these fields:

| Field | What it holds |
|---|---|
| `event_id` | A random id for this event, so it is stored once even if it is sent twice |
| `installation_id` | The random id of this installation, made when you turn reporting on |
| `command` | The command that ran, one of those listed above |
| `succeeded` | Whether the command succeeded |
| `occurred_at` | When it ran, in UTC to the millisecond |
| `cli_version` | The CLI version, for example `0.1.738` |
