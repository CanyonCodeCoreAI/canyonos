# CLI reference

Every `canyonos` command and its options. `canyonos -h` lists the commands, and
`canyonos <command> --help` shows one command's options. How the CLI works inside is in
[CLI architecture](../architecture/CLI.md).

Run `new-app`, `convert` and `validate` from the workflow folder, the folder that holds
`config/` or `.canyon/`. Run `deploy` from any folder, that one included. Each workflow
group's settings (`workflow_group.yaml` and its `.env`) and the CLI's state for it live
in its record, `~/.canyonos/workflows/<workflow group>/`, never in your folders. So
does each workflow's `config/`, from its first deploy on; its code and `.env` stay in
its folder. Run the other commands from one of its workflow folders. A typical session:

```bash
cd my-workflow
canyonos doctor                       # can this machine deploy?
# build the images, start the workflow, save its workflow group's API key, open the dashboard
canyonos deploy . --api-key <your api key>
canyonos test "hello"                 # send one query end to end
canyonos logs my-workflow.MyAgent     # print one agent's logs
canyonos dashboard                    # open the dashboard, signed in
canyonos stop                         # take the deploy down, keeping its images
```

From any other folder, `canyonos select-context <workflow group>` picks the workflow
group those commands act on; see [Pick a workflow group](#pick-a-workflow-group).

## Start a workflow

| Command      | What it does                                                                    |
| ------------ | ------------------------------------------------------------------------------- |
| `quickstart` | Guided first run: picks a sample workflow, deploys it and sends a first request |
| `new-app`    | Create a starter workflow with two agents in an empty folder                    |
| `convert`    | Convert an existing workflow to the CanyonOS format with your coding agent      |
| `validate`   | Check the workflow folder against the CanyonOS contract                         |
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

| Command     | What it does                                                                           |
| ----------- | -------------------------------------------------------------------------------------- |
| `deploy`    | Build an image per agent, start the workflow, and open the dashboard                   |
| `test`      | Send one query end to end and show the answer                                          |
| `curl`      | POST one JSON body to the workflow and print what it answers                           |
| `status`    | Show whether a workflow group is running, its endpoint, and how to query it            |
| `logs`      | Stream the Global Controller's logs until Ctrl-C                                       |
| `config`    | View or edit `workflow_group.yaml`; `sync` applies the changes                         |
| `sync`      | Apply changes you made by hand in the record's `config/` to the running workflow group |
| `serve`     | Start the local dashboard on its own                                                   |
| `dashboard` | Open the running dashboard, signed in with the workflow group's key                    |

- `deploy <folder>...` deploys the workflow folders it names as one workflow group: the
  recorded one that has exactly those folders, by absolute path, else a new one. Two
  folders with the same name are two workflow groups.
- A new workflow group starts from the `workflow_group.yaml` of the folder `deploy` runs
  from when there is one, as in the examples, copied into its record once, its
  `workflow_group_id` and settings kept, and is named after that folder. Else it starts
  from the starter `workflow_group.yaml` and is named after its first workflow folder.
  After that the folder's copy is not read, and the CLI says so: edit the record's, or
  use `config`. The `.env` beside it is copied in with it, readable only by you, and
  is not read after that either.
- A workflow's first deploy copies its `config/` (from `.canyon/` after `convert`) into
  the record, `~/.canyonos/workflows/<workflow group>/<workflow>/config/`, and says so.
  From then on that copy is deployed, with the code and `.env` in the folder: edit it
  there. `deploy` and `sync` warn when the folder's `config/` changed since; the
  folder's may be deleted. `validate` and `convert` still work on the folder's.
- A workflow group is a name. `deploy <folder>... --workflow-group <name>` makes the
  workflow group of that name when there is none, from any folder.
  `deploy --workflow-group <name or ID>` deploys a recorded one from any folder: with no
  folders, the ones it records; with other folders, it replaces its workflows, stopping
  the ones left out, after asking, and deletes their `config/` from the record. `-y`
  skips the question; without a terminal and without `-y`, it refuses. `canyonos list`
  shows each one's name and ID, deployed or not.
- An older CLI's records, `~/.canyonos/deployments/<workflow group>/`, move into the
  workflow group's record on its first deploy.
- `deploy --serve false` doesn't open the dashboard. On Docker, `-v` streams the full
  build and deploy logs instead of a progress summary.
- `deploy --api-key <key>` saves the workflow group's API key in its record,
  `~/.canyonos/workflows/<workflow group>/api_key`, replacing its saved one, and says
  `This workflow group now uses an API key for secure connections.`; later deploys of
  it reuse it. Other workflow groups keep their own keys. `--no-api-key` deletes it and
  runs the workflow group open. Without a key, `deploy` warns that anyone who reaches
  its endpoint and its dashboard routes can use them. `serve` takes no key. See
  [API key](AUTHORIZATION.md).
- `test` sends the workflow group's API key with each request.
- `deploy -y` deploys the resources the config sets, without the resource picker, and
  replaces a workflow group's workflows without asking.
  `--detach` returns once the deploy has started, without the dashboard; `status`
  says when it is up and `logs` follows it.
- `test "your query"` sends that query to every route. Without one, each route gets its
  workflow's `config/test_query.txt`, else `hello`.
- `test` queries every route of this folder's workflow group. It never
  deploys, and fails when none runs.
- `test` on Kubernetes queries the workflow already deployed there.
- `test --timeout SECONDS` sets the wait (default 300), which restarts after each answer
  you give. `--json` prints one JSON result, for CI.
- `curl '<json>'` POSTs that body to the running workflow group's workflow endpoint, with
  the workflow group's API key, and prints the answer, indented when it is JSON:
  `canyonos curl '{"query": "World"}'` prints the queued request's `request_id`. It
  sends that one request and waits for nothing more; `/status/<request_id>` has the
  result. It exits 0 on a 2xx answer, else 1 with the status code. A body that is not
  JSON is refused.
- `curl` calls this folder's workflow group, else the selected one; with neither, it
  fails and points to `canyonos list` and `canyonos select-context`. It calls Docker
  workflow groups.
- `curl --route <workflow>/<agent>/<method>` picks the route of a workflow group that serves
  several; `<agent>/<method>`, `<method>` or the route's URL work too. Without it, a
  terminal shows a menu of the routes, and a run with no terminal fails listing them.
- `curl --print` prints the equivalent `curl` command instead of sending it, with
  `<your api key>` in place of the key.
- `status --json` prints one JSON object: the workflow group, its target, the deploy's
  `phase` (`starting`, `up`, `failed` or `stopped`, on Docker), the address of the
  CanyonOS API it read them from (`controller_url`) and each agent's replica counts. On
  Kubernetes, `kubernetes` names the cluster's kubectl `context` and the `namespace`.
  When the status couldn't be read, `errors` says why and `failure_code` names it as
  `--json` names a failure, such as `version_mismatch`: the deploy, or on Kubernetes the
  cluster's CanyonOS API, runs another release than the CLI.
- `logs <agent>` prints that agent's logs instead of the Global Controller's, the agent
  named `<workflow>.<agent>` on Docker. A replica ID prints one replica:
  `my-workflow.MyAgent-1a2b3c4d` on Docker, `MyAgent-0` on Kubernetes. An agent's logs
  print once on Docker and stream on Kubernetes.
- `logs --tail N` shows the last N lines (default 200, or `all`); `--no-follow` prints
  them and exits.
- `sync <folder>...` copies those workflow folders with their `.env` and the record's
  `config/` for each, and `workflow_group.yaml` and the `.env` beside it, into the
  running workflow group and has it reload
  the config; code changes need `deploy`. `sync` and `config` change a deploy on Docker
  only; on Kubernetes, run `deploy` again. See
  [Configure your workflow](CONFIGURE.md#apply-a-change) for which command applies what.
- `dashboard` opens the dashboard signed in, with the workflow group's API key in the
  link's `#key=` fragment, which the browser never sends to a server; the sign-in screen saves it and
  drops the fragment. For a workflow group with no key, it opens the dashboard as it is.
- `deploy`, `sync`, `stop`, `clean`, `logs`, `doctor` and `provision` take `--json`: they
  print one JSON object, `ok`, the `errors` they hit, a `code` and their result, and
  nothing else. `code` is null on success, else why it failed, such as `no_deploy`,
  `docker_unavailable`, `workflow_invalid`, `deploy_failed`, `version_mismatch` or, on
  Kubernetes, `canyonos_missing`: the cluster has no CanyonOS API (`cluster up` sets it up
  on a local cluster).
  `deploy` adds what `status --json` prints under `status`, `stop` and `clean` the
  `workflow_groups` they acted on, `logs` the lines it read under `logs`, `doctor` its
  `checks`, `sync` the `reload` it applied, `target` the `target`, `provision aws` the
  `machine` it launched (ID, address, region, SSH user and key) and `provision teardown`
  what it `removed`.
- After upgrading the CLI, run `deploy` again: `status`, `sync`, `test`, `logs` and
  `doctor` refuse a deploy started by another release (`stop` still works).
- Exit code: 3 when no deploy is running, for `status`, `logs` and `test`, or when
  `sync` finds the deploy's Global Controller gone; 4 when Docker can't be used, for
  `deploy`; 1 for any other failure.

## Pick a workflow group

```bash
canyonos list                                 # every workflow group on this machine
canyonos select-context my-workflow-1a2b3c4d  # act on it from any other folder
canyonos select-context --clear               # forget it
```

| Command          | What it does                                                            |
| ---------------- | ----------------------------------------------------------------------- |
| `list`           | One line per workflow group: name, `workflow_group_id`, whether it runs |
| `select-context` | Pick the workflow group commands act on outside its workflow folders    |

- `list --json` prints one JSON object: each workflow group under `workflow_groups`, with
  its name, `workflow_group_id`, its `record` folder, whether it is `deployed` and
  `running` (`"unknown"` when the CanyonOS API can't say), its `target` and its
  `workflows` with each one's folder; the `selected` one; and `records_dir`, the folder
  holding every record. `--no-status` doesn't ask the API whether each deploy runs (on
  Kubernetes, a port-forward each): a deployed one's `running` is `"unchecked"`.
- `list` marks a workflow group deployed without an API key `(unauthenticated)`, one
  recorded but not deployed `not deployed`, and the selected one `(selected)`. It lists
  the workflow groups recorded in `~/.canyonos/workflows/`, the Docker ones on this
  machine.
- `select-context` takes a name, ID or the start of an ID, as `stop` does.
- Without a name, `stop`, `clean`, `status`, `logs`, `test`, `sync`, `curl`, `config`
  and `doctor` act on the workflow group of the folder they run from: one of its
  workflow folders, a folder inside one, or a folder that holds one. Else they act on
  the selected workflow group. A folder that belongs to several workflow groups, with
  none selected, is an error.
- A selected workflow group that is no longer recorded is an error until you pick
  another or `--clear` it.

## Stop and clean up

```bash
canyonos stop                       # this folder's workflow group, or pick from a list
canyonos stop my-workflow-1a2b3c4d  # a workflow group by name or ID, from any folder
canyonos stop --all                 # every workflow group on this machine
```

| Command | What it does                                                                                                   |
| ------- | -------------------------------------------------------------------------------------------------------------- |
| `stop`  | Remove the workflow group's containers, workspace and network, keeping its images and `.canyon`                |
| `clean` | Stop the workflow group, then remove the agents' images and the workflow group's record, its settings included |

- Both work from any folder. Name workflow groups by name (with or without the start of
  its ID), ID or the start of an ID; a name two workflow groups share is refused, so use
  the ID. Names and `--all` don't mix.
- Without a name, they act on this folder's workflow group, else the selected one
  (`canyonos select-context`), else the only workflow group. With more than one, they
  list them: tick the ones you want with space, then press enter. Without a terminal
  they list them and act on none, so pass the names. `stop` lists only the deployed
  ones.
- `stop` also stops the dashboard, keeping its history, when no other workflow group runs.
- `clean` removes the workflow group's record, `~/.canyonos/workflows/<workflow
group>/`, its `workflow_group.yaml`, each workflow's `config/` and Redis password
  among them, and the skills `convert` installed in its workflow folders, keeping their
  `.canyon`. Run from a folder
  that is not deployed, it also offers to remove that folder's `.canyon` and the skills
  `convert` installed there. It leaves a skill that `convert --scope global` installed.
  When the stop fails or is refused, `clean` removes nothing.
- `stop --all` stops every workflow group on this machine, even one whose workflow
  folders are deleted.
- `clean --all` removes everything CanyonOS put on this machine, for before you
  uninstall: every workflow group, the dashboard and its data, CanyonOS's images and
  `~/.canyonos`, the keys included. It asks first; `-y` skips the question.
- `--all` and workflow group names act on this machine's Docker only. On Kubernetes,
  `stop` and `clean` act on this folder's workflow in the cluster; see
  [Kubernetes workflow group](KUBERNETES.md).

## Where it runs

| Command     | What it does                                                                     |
| ----------- | -------------------------------------------------------------------------------- |
| `cluster`   | Make (`up`) or delete (`down`) a local Kubernetes cluster with CanyonOS, on kind |
| `provision` | Set up or tear down an AWS machine to deploy from                                |

- `cluster up --workers N` sets a new cluster's worker count (default 1). `cluster up`
  again keeps the cluster and upgrades CanyonOS on it to the CLI's release.
  `cluster down --all` also removes the local registry and its images.
- `deploy`, `status`, `test`, `logs`, `serve`, `doctor`, `stop` and `clean` use the
  `target` in the workflow group's `workflow_group.yaml`, else `docker`. See
  [Kubernetes workflow group](KUBERNETES.md) and [EC2 workflow group](EC2.md).

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
