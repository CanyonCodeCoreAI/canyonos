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
| `test` | Deploy locally and send one test prompt end to end, or send it to the deploy that's already running if your files haven't changed since it started |
| `logs` | Re-attach to the deploy log stream |
| `serve` | Start the local dashboard separately |
| `stop` | Remove the deploy's containers, network and workspace, keeping its images; stop the dashboard, keeping its history, if no other project runs |
| `clean` | Stop the project if it is deployed, then remove the generated `.canyon` folder (and the project id, when `global_controller.yaml` lives there, so the next deploy is a new dashboard project), the project's CanyonOS skill, and the Docker images of the agents in this project's `global_controller.yaml` |
| `convert` | Optional: convert an existing workflow to CanyonOS format using your coding agent |
| `validate` | Check the project root against the CanyonOS contract |
| `doctor` | Check that your environment is ready and, once deployed, every part of the deploy |
| `target` | Show or choose where this project deploys: Docker on this machine, or Kubernetes |
| `new-app` | Create a starter project with one agent in an empty folder |
| `upgrade` | Upgrade the canyonos CLI to the latest release |
| `-v`, `--version` | Print the installed version |

A project runs on Docker on this machine unless its config says `target: kubernetes`,
which `canyonos target kubernetes` sets: then `deploy`, `status`, `test`, `logs`,
`serve`, `doctor`, `stop` and `clean` work on the cluster `kubectl` points at. Any of
them takes `--target docker` or `--target kubernetes` to override it once; see
[Kubernetes deployment](KUBERNETES.md).

## Contact

| Command | What it does |
|---|---|
| `contact` | See or change whether the CLI shares usage reporting with Canyon Code |
| `feedback` | Send a message to Canyon Code |

## Usage reporting

Usage reporting is on by default. Before the first event is recorded, the CLI prints a notice on stderr saying that the command that just finished will be reported, what is sent, a link to this section and the command that turns it off. The notice is shown once. That first event is not sent until your next `canyonos` command, so running `canyonos contact --usage off` right after the notice deletes it and nothing is ever sent.

Each run of `new-app`, `convert`, `validate`, `deploy`, `test`, `serve`, `stop` or `clean` records one event: the command name, whether it succeeded, when it ran, the CLI version and a random installation id. No sensitive information is sent: never your arguments, paths, prompts, code, environment variables, credentials or anything else. Events are sent in the background, so sending never slows your commands down or changes their output; an event is deleted only once the API has stored it.

To turn it off, run `canyonos contact --usage off`. That also deletes the unsent events and forgets the installation id. `canyonos contact` shows your choice and, in a terminal, lets you change it; `canyonos contact --usage on` turns it on again under a new id.

Each event holds only these fields:

| Field | What it holds |
|---|---|
| `event_id` | A random id for this event, so it is counted once even if it is sent twice |
| `installation_id` | The random id of this installation, made with the first event or when you turn reporting back on |
| `command` | The command that ran, one of those listed above |
| `succeeded` | Whether the command succeeded |
| `occurred_at` | When it ran, in UTC to the millisecond |
| `cli_version` | The CLI version, for example `0.2.0` |

## Feedback

`canyonos feedback "your message"` sends your message to Canyon Code right away, with the CLI version, your OS and CPU type. When usage reporting has an installation id, it also sends it. Otherwise it sends no installation id and asks before sending; `--yes` skips the question, and a non-interactive run without it sends nothing.
