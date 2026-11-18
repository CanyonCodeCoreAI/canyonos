# CLI reference

Every `canyonos` command and its options. `canyonos -h` lists the commands, and
`canyonos <command> --help` shows one command's options. How the CLI works inside is in
[CLI architecture](../architecture/CLI.md).

Run `new-app`, `convert` and `validate` from the project folder, the folder that holds
`config/` or `.canyon/`. Run `deploy` from the folder above it; `--folder` names the deployment's own folder, which
holds `deployment.yaml`; run the others from there. A typical session:

```bash
canyonos doctor                       # can this machine deploy?
# build the images, start the workflow, save the machine's API key, open the dashboard
canyonos deploy my-project --folder my-deployment --api-key <your api key>
cd my-deployment
canyonos test "hello"                 # send one query end to end
canyonos logs my-project.MyAgent      # print one agent's logs
canyonos dashboard                    # open the dashboard, signed in
canyonos stop                         # take the deploy down, keeping its images
```

From any other folder, `canyonos select-context my-deployment` picks the deployment
those commands act on; see [Pick a deployment](#pick-a-deployment).

## Start a workflow

| Command      | What it does                                                                    |
| ------------ | ------------------------------------------------------------------------------- |
| `quickstart` | Guided first run: picks a sample workflow, deploys it and sends a first request |
| `new-app`    | Create a starter project with two agents in an empty folder                     |
| `convert`    | Convert an existing workflow to the CanyonOS format with your coding agent      |
| `validate`   | Check the project folder against the CanyonOS contract                          |
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

| Command     | What it does                                                         |
| ----------- | -------------------------------------------------------------------- |
| `deploy`    | Build an image per agent, start the workflow, and open the dashboard |
| `test`      | Send one query end to end and show the answer                        |
| `status`    | Show whether a deploy is running, its endpoint, and how to query it  |
| `logs`      | Stream the Global Controller's logs until Ctrl-C                     |
| `config`    | View or edit `deployment.yaml`; `sync` applies the changes           |
| `sync`      | Apply changes you made by hand in `config/` to the running deploy    |
| `serve`     | Start the local dashboard on its own                                 |
| `dashboard` | Open the running dashboard, signed in with this machine's API key    |

- `deploy <folder>... --folder PATH` deploys the project folders it names as one
  deployment, named after the deployment folder `PATH`, made when missing. It writes
  `deployment.yaml` there when there is none. To redeploy from inside the deployment
  folder, leave out `--folder`: `canyonos deploy ../my-project`. It refuses to run
  from inside a project folder.
- `deploy --serve false` doesn't open the dashboard. On Docker, `-v` streams the full
  build and deploy logs instead of a progress summary.
- `deploy --api-key <key>` and `serve --api-key <key>` save the machine's API key to
  `~/.canyonos/api_key`, replacing any saved one; later runs reuse it. `--no-api-key`
  deletes it and runs open. Without a key, they warn that anyone who reaches the
  endpoint and the dashboard can use them. See [API key](AUTHORIZATION.md).
- `test` sends the saved API key with each request.
- `test "your query"` sends that query to every route. Without one, each route gets its
  project's `config/test_query.txt`, else `hello`.
- `test` queries every route of the deployment running from this folder. It never
  deploys, and fails when none runs.
- `test` on Kubernetes queries the workflow already deployed there.
- `test --timeout SECONDS` sets the wait (default 300), which restarts after each answer
  you give. `--json` prints one JSON result, for CI.
- `status --json` prints one JSON object with each agent's replica counts.
- `logs <agent>` prints that agent's logs instead of the Global Controller's, the agent
  named `<project>.<agent>` on Docker. A replica ID prints one replica:
  `my-project.MyAgent-1a2b3c4d` on Docker, `MyAgent-0` on Kubernetes. An agent's logs
  print once on Docker and stream on Kubernetes.
- `logs --tail N` shows the last N lines (default 200, or `all`); `--no-follow` prints
  them and exits.
- `sync <folder>...` copies those project folders and their `.env`, and
  `deployment.yaml` and the `.env` beside it, into the running deploy and has it reload
  the config; code changes need `deploy`. `sync` and `config` change a deploy on Docker
  only; on Kubernetes, run `deploy` again. See
  [Configure your workflow](CONFIGURE.md#apply-a-change) for which command applies what.
- `dashboard` opens the dashboard signed in, with the API key in the link's `#key=`
  fragment, which the browser never sends to a server; the sign-in screen saves it and
  drops the fragment. With no key set, it opens the dashboard as it is.

## Pick a deployment

```bash
canyonos list                          # every deployment on this machine
canyonos select-context my-deployment  # act on it from any other folder
canyonos select-context --clear        # forget it
```

| Command          | What it does                                                         |
| ---------------- | -------------------------------------------------------------------- |
| `list`           | One line per deployment: name, `deployment_id`, whether it runs      |
| `select-context` | Pick the deployment commands act on outside a deployment folder      |

- `list` marks a deployment deployed without an API key `(unauthenticated)`, and the
  selected one `(selected)`. It lists the deployments recorded in
  `~/.canyonos/deployments/`, the Docker ones on this machine.
- `select-context` takes a name, folder name, ID or the start of an ID, as `stop` does.
- Outside a deployment folder, `stop`, `clean`, `status`, `logs`, `test` and `sync` act
  on the selected deployment when you name none. A name, or running from a deployment
  folder, always wins.
- A selected deployment that is no longer deployed is an error until you pick another
  or `--clear` it.

## Stop and clean up

```bash
canyonos stop                  # the only deployment, or pick from a list
canyonos stop my-deployment    # a deployment by name, folder name or ID, from any folder
canyonos stop --all            # every deployment on this machine
```

| Command | What it does                                                                                                                     |
| ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `stop`  | Remove the deploy's containers, workspace and network, keeping its images and `.canyon`                                          |
| `clean` | Stop the deployment, then remove the agents' images and the deployment's records; each project's `.canyon` stays                 |

- Both work from any folder. Name deployments by name, folder name, ID or the start of
  an ID; a name two deployments share is refused, so use the ID. Names and `--all` don't
  mix.
- Without a name, outside a deployment folder, they act on the selected deployment
  (`canyonos select-context`). Else they act on the only deployment. With more than
  one, they list them: tick the ones you want with space, then press enter. Without a
  terminal they list them and act on none, so pass the names. `clean` also offers this
  folder's deployment.
- `stop` also stops the dashboard, keeping its history, when no other deployment runs.
- `clean` removes the deployment's records in `~/.canyonos/deployments/<deployment>/`,
  its Redis password among them. It leaves a skill that `convert --scope global`
  installed. When the stop fails or is refused, `clean` removes nothing.
- `stop --all` stops every deployment on this machine, even one whose folder is deleted.
- `clean --all` removes everything CanyonOS put on this machine, for before you
  uninstall: every deployment, the dashboard and its data, CanyonOS's images and
  `~/.canyonos`, the API key included. It asks first; `-y` skips the question.
- `--all` and deployment names act on this machine's Docker only, so they are refused
  with `--target kubernetes`. On Kubernetes, `stop` and `clean` act on this folder's
  workflow in the cluster; see [Kubernetes deployment](KUBERNETES.md).

## Where it runs

| Command     | What it does                                                                     |
| ----------- | -------------------------------------------------------------------------------- |
| `target`    | Show or choose where this deployment runs: Docker on this machine or Kubernetes  |
| `cluster`   | Make (`up`) or delete (`down`) a local Kubernetes cluster with CanyonOS, on kind |
| `provision` | Set up or tear down an AWS machine to deploy from                                |

- `target` alone shows where the deployment runs and checks this machine can reach it.
- `target kubernetes` makes the cluster `kubectl` points at this deployment's default.
  `--namespace` sets its namespace (default: the folder's name), and `--registry` where
  images are pushed (default: the local registry the cluster advertises, else it asks).
  `target docker` switches back.
- `cluster up --workers N` sets a new cluster's worker count (default 1). `cluster up`
  again keeps the cluster and upgrades CanyonOS on it to the CLI's release.
  `cluster down --all` also removes the local registry and its images.
- `--target docker` or `--target kubernetes` overrides the deployment's target for one
  run of `deploy`, `status`, `test`, `logs`, `serve`, `doctor`, `stop` or `clean`.
  Without it, they use the `target` in `deployment.yaml`, else `docker`. See
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
