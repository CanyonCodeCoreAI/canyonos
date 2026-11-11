# CLI reference

Every `canyonos` command and its options. `canyonos -h` lists the commands, and
`canyonos <command> --help` shows one command's options. How the CLI works inside is in
[CLI architecture](../architecture/CLI.md).

Run the commands from the workflow root, the folder that holds `config/` or `.canyon/`.
A typical session:

```bash
canyonos doctor          # can this machine deploy?
canyonos deploy          # build the images, start the workflow, open the dashboard
canyonos test "hello"    # send one query end to end
canyonos logs MyAgent    # print one agent's logs
canyonos stop            # take the deploy down, keeping its images
```

## Start a workflow

| Command      | What it does                                                                    |
| ------------ | ------------------------------------------------------------------------------- |
| `quickstart` | Guided first run: picks a sample workflow, deploys it and sends a first request |
| `new-app`    | Create a starter workflow with one agent in an empty folder                     |
| `convert`    | Convert an existing workflow to the CanyonOS format with your coding agent      |
| `validate`   | Check the workflow root against the CanyonOS contract                           |
| `doctor`     | Check that this machine can deploy and, once deployed, every part of the deploy |

- `convert --agent <name>` picks the coding agent instead of asking: `claude`, `codex`,
  `gemini`, `opencode`, `pi`, `copilot`, `cursor`, `droid`, `grok`, `devin`, `mastra`,
  `deepagents`, `vibe` or `cline`.
- `convert --scope local|global` installs the skill in this folder or for your user,
  instead of asking.
- `convert -y` never asks: it takes `claude` and `local` for any you didn't give, and
  runs the agent unattended. `--install-only` installs the skill and exits.
- `validate [folder]` checks another folder. `--json` prints only one JSON result, for
  CI. Exit code: 0 when it finds nothing, 1 when it finds a problem, 2 when the check
  could not run.

## Deploy and run

| Command  | What it does                                                         |
| -------- | -------------------------------------------------------------------- |
| `deploy` | Build an image per agent, start the workflow, and open the dashboard |
| `test`   | Send one query end to end and show the answer                        |
| `status` | Show whether a deploy is running, its endpoint, and how to query it  |
| `logs`   | Stream the Global Controller's logs until Ctrl-C                     |
| `config` | View or edit the workflow config; changes apply to a running deploy  |
| `sync`   | Apply changes you made by hand in `config/` to the running deploy    |
| `serve`  | Start the local dashboard on its own                                 |

- `deploy --serve false` doesn't open the dashboard. On Docker, `-v` streams the full
  build and deploy logs instead of a progress summary.
- `test "your query"` sends that query, else `config/test_query.txt`, else `hello`.
- `test` with a deploy running queries it as it stands, but refuses if your files
  changed since: run `deploy` for code changes or `sync` for `config/` changes, then
  test again.
- `test` with none running deploys locally with `provider: local`, queries it, and stops
  it if the test passes. A failed deploy stays running, with the end of its log printed.
- `test` on Kubernetes never deploys; it queries the workflow already deployed there.
- `test --timeout SECONDS` sets the wait (default 300), which restarts after each answer
  you give. `--json` prints one JSON result, for CI.
- `status --json` prints one JSON object with each agent's replica counts.
- `logs <agent>` prints that agent's logs instead of the Global Controller's. A replica
  ID prints one replica: `MyAgent-1a2b3c4d` on Docker, `MyAgent-0` on Kubernetes. An
  agent's logs print once on Docker and stream on Kubernetes.
- `logs --tail N` shows the last N lines (default 200, or `all`); `--no-follow` prints
  them and exits.
- `sync` copies the workflow root and its `.env` into the running deploy and has it
  reload the workflow config; code changes need `deploy`. `sync` and `config` change a
  deploy on Docker only; on Kubernetes, run `deploy` again. See
  [Configure your workflow](CONFIGURE.md#apply-a-change) for which command applies what.

## Stop and clean up

```bash
canyonos stop                # the only deployed workflow, or pick from a list
canyonos stop helloworld     # a workflow by name, folder name or ID, from any folder
canyonos stop --all          # every workflow on this machine
```

| Command | What it does                                                                                                                     |
| ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `stop`  | Remove the deploy's containers, workspace and network, keeping its images and `.canyon`                                          |
| `clean` | Stop the deploy, then remove `.canyon`, the CanyonOS skill in the workflow folder, the agents' images and the workflow's records |

- Both work from any folder. Name workflows by name, folder name, ID or the start of an
  ID; a name two workflows share is refused, so use the ID. Names and `--all` don't mix.
- Without a name, they act on the only deployed workflow. With more than one, they list
  them: tick the ones you want with space, then press enter. Without a terminal they
  list them and act on none, so pass the names. `clean` also offers this folder's
  workflow.
- `stop` also stops the dashboard, keeping its history, when no other workflow runs.
- `clean` removes the workflow's records in `~/.canyonos/projects/<project>/`, its Redis
  password among them, and the `project_id` when the workflow config lives in
  `.canyon`. It leaves a skill that `convert --scope global` installed. When the stop
  fails or is refused, `clean` removes nothing.
- `stop --all` stops every workflow on this machine, even one whose folder is deleted.
- `clean --all` removes everything CanyonOS put on this machine, for before you
  uninstall: every workflow, the dashboard and its data, CanyonOS's images and
  `~/.canyonos`. It asks first; `-y` skips the question.
- `--all` and workflow names act on this machine's Docker only, so they are refused
  with `--target kubernetes`. On Kubernetes, `stop` and `clean` act on this folder's
  workflow in the cluster; see [Kubernetes deployment](KUBERNETES.md).

## Where it runs

| Command     | What it does                                                                     |
| ----------- | -------------------------------------------------------------------------------- |
| `target`    | Show or choose where this workflow deploys: Docker on this machine or Kubernetes |
| `cluster`   | Make (`up`) or delete (`down`) a local Kubernetes cluster with CanyonOS, on kind |
| `provision` | Set up or tear down an AWS machine to deploy from                                |

- `target` alone shows where the workflow deploys and checks this machine can reach it.
- `target kubernetes` makes the cluster `kubectl` points at this workflow's default.
  `--namespace` sets its namespace (default: the folder's name), and `--registry` where
  images are pushed (default: the local registry the cluster advertises, else it asks).
  `target docker` switches back.
- `cluster up --workers N` sets a new cluster's worker count (default 1). `cluster up`
  again keeps the cluster and upgrades CanyonOS on it to the CLI's release.
  `cluster down --all` also removes the local registry and its images.
- `--target docker` or `--target kubernetes` overrides the workflow's target for one
  run of `deploy`, `status`, `test`, `logs`, `serve`, `doctor`, `stop` or `clean`.
  Without it, they use the workflow config's `target`, else `docker`. See
  [Kubernetes deployment](KUBERNETES.md) and [EC2 deployment](EC2.md).

## Other commands

| Command           | What it does                                                          |
| ----------------- | --------------------------------------------------------------------- |
| `upgrade`         | Upgrade the CLI to the latest release, when installed with `uv tool`  |
| `contact`         | See or change whether the CLI shares usage reporting with Canyon Code |
| `feedback`        | Send a message to Canyon Code                                         |
| `-v`, `--version` | Print the installed version                                           |

- `upgrade` on a CLI not installed with `uv tool` changes nothing and prints the
  command that reinstalls it.
- `contact --usage on|off` changes usage reporting without asking; see
  [Usage reporting](#usage-reporting).
- `feedback "message" -y` sends without asking; see [Feedback](#feedback).

## Usage reporting

Usage reporting is on by default. Before the first event is recorded, the CLI prints a
notice on stderr, once. It says that the command that just finished will be reported,
what is sent and which command turns reporting off, and links to this section. That
first event is not sent until your next `canyonos` command, so running
`canyonos contact --usage off` right after the notice deletes it and nothing is ever
sent.

Each run of `new-app`, `convert`, `validate`, `deploy`, `test`, `serve`, `stop` or
`clean` records one event: the command name, whether it succeeded, when it ran, the CLI
version and a random installation id. No sensitive information is sent: never your
arguments, paths, prompts, code, environment variables, credentials or anything else.
Events are sent in the background, so sending never slows your commands down or changes
their output. An event is deleted only once the API has stored it.

`canyonos contact --usage off` turns reporting off, deletes the unsent events and
forgets the installation id. `canyonos contact` shows your choice and, in a terminal,
lets you change it. `canyonos contact --usage on` turns reporting on again under a new
id.

Each event holds only these fields:

| Field             | What it holds                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| `event_id`        | A random id for this event, so it is counted once even if it is sent twice                       |
| `installation_id` | The random id of this installation, made with the first event or when you turn reporting back on |
| `command`         | The command that ran, one of those listed above                                                  |
| `succeeded`       | Whether the command succeeded                                                                    |
| `occurred_at`     | When it ran, in UTC to the millisecond                                                           |
| `cli_version`     | The CLI version, for example `0.2.0`                                                             |

## Feedback

`canyonos feedback "your message"` sends your message, up to 4,000 characters, to
Canyon Code right away, with the CLI version, your OS and your CPU type. When usage
reporting has an installation id, that is sent too. Otherwise no installation id is
sent, and the command asks first: `-y` or `--yes` skips the question, and a run without
a terminal and without `--yes` sends nothing.
