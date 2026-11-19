# CLI reference

Every `canyonos` command and its options. `canyonos -h` lists the commands, and
`canyonos <command> --help` shows one command's options. How the CLI works inside is in
[CLI architecture](../architecture/CLI.md).

Run `new-app`, `convert` and `validate` from the workflow folder, the folder that holds
`config/` or `.canyon/`. Run `deploy` from the folder above it; `--workflow-group` names the workflow group's own folder, which
holds `workflow_group.yaml`; run the others from there. A typical session:

```bash
canyonos doctor                       # can this machine deploy?
# build the images, start the workflow, save the machine's API key, open the dashboard
canyonos deploy my-workflow --workflow-group my-group --api-key <your api key>
cd my-group
canyonos test "hello"                 # send one query end to end
canyonos logs my-workflow.MyAgent     # print one agent's logs
canyonos dashboard                    # open the dashboard, signed in
canyonos stop                         # take the deploy down, keeping its images
```

From any other folder, `canyonos select-context my-group` picks the workflow group
those commands act on; see [Pick a workflow group](#pick-a-deployment).

## Start a workflow

| Command      | What it does                                                                    |
| ------------ | ------------------------------------------------------------------------------- |
| `quickstart` | Guided first run: picks a sample workflow, deploys it and sends a first request |
| `new-app`    | Create a starter workflow with two agents in an empty folder                    |
| `convert`    | Convert an existing workflow to the CanyonOS format with your coding agent      |
| `validate`   | Check the workflow folder against the CanyonOS contract                          |
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
| `curl`      | POST one JSON body to the workflow and print what it answers         |
| `status`    | Show whether a workflow group is running, its endpoint, and how to query it |
| `logs`      | Stream the Global Controller's logs until Ctrl-C                     |
| `config`    | View or edit `workflow_group.yaml`; `sync` applies the changes           |
| `sync`      | Apply changes you made by hand in `config/` to the running workflow group |
| `serve`     | Start the local dashboard on its own                                 |
| `dashboard` | Open the running dashboard, signed in with this machine's API key    |

- `deploy <folder>... --workflow-group PATH` deploys the workflow folders it names as one
  workflow group, named after the workflow group folder `PATH`, made when missing. It writes
  `workflow_group.yaml` there when there is none. To redeploy from inside the workflow group
  folder, leave out `--workflow-group`: `canyonos deploy ../my-workflow`. It refuses to run
  from inside a workflow folder.
- `deploy --serve false` doesn't open the dashboard. On Docker, `-v` streams the full
  build and deploy logs instead of a progress summary.
- `deploy --api-key <key>` and `serve --api-key <key>` save the machine's API key to
  `~/.canyonos/api_key`, replacing any saved one, and say `Your deploys now use an API
  key for secure connections.`; later runs reuse it. `--no-api-key`
  deletes it and runs open. Without a key, they warn that anyone who reaches the
  endpoint and the dashboard can use them. See [API key](AUTHORIZATION.md).
- `test` sends the saved API key with each request.
- `deploy -y` deploys the resources the config sets, without the resource picker.
  `--detach` returns once the deploy has started, without the dashboard; `status`
  says when it is up and `logs` follows it.
- `test "your query"` sends that query to every route. Without one, each route gets its
  workflow's `config/test_query.txt`, else `hello`.
- `test` queries every route of the workflow group running from this folder. It never
  deploys, and fails when none runs.
- `test` on Kubernetes queries the workflow already deployed there.
- `test --timeout SECONDS` sets the wait (default 300), which restarts after each answer
  you give. `--json` prints one JSON result, for CI.
- `curl '<json>'` POSTs that body to the running workflow group's workflow endpoint, with
  the saved API key, and prints the answer, indented when it is JSON:
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
  `phase` (`starting`, `up`, `failed` or `stopped`, on Docker), the Global Controller's
  address (`controller_url`, on Docker) and each agent's replica counts.
- `logs <agent>` prints that agent's logs instead of the Global Controller's, the agent
  named `<workflow>.<agent>` on Docker. A replica ID prints one replica:
  `my-workflow.MyAgent-1a2b3c4d` on Docker, `MyAgent-0` on Kubernetes. An agent's logs
  print once on Docker and stream on Kubernetes.
- `logs --tail N` shows the last N lines (default 200, or `all`); `--no-follow` prints
  them and exits.
- `sync <folder>...` copies those workflow folders and their `.env`, and
  `workflow_group.yaml` and the `.env` beside it, into the running workflow group and has it reload
  the config; code changes need `deploy`. `sync` and `config` change a deploy on Docker
  only; on Kubernetes, run `deploy` again. See
  [Configure your workflow](CONFIGURE.md#apply-a-change) for which command applies what.
- `dashboard` opens the dashboard signed in, with the API key in the link's `#key=`
  fragment, which the browser never sends to a server; the sign-in screen saves it and
  drops the fragment. With no key set, it opens the dashboard as it is.
- `deploy`, `sync`, `stop`, `clean`, `logs` and `doctor` take `--json`: they
  print one JSON object, `ok`, the `errors` they hit, a `code` and their result, and
  nothing else. `code` is null on success, else why it failed, such as `no_deploy`,
  `docker_unavailable`, `workflow_invalid`, `deploy_failed` or `version_mismatch`.
  `deploy` adds what `status --json` prints under `status`, `stop` and `clean` the
  `workflow_groups` they acted on, `logs` the lines it read under `logs`, `doctor` its
  `checks`, `sync` the `reload` it applied, and `target` the `target`.
- After upgrading the CLI, run `deploy` again: `status`, `sync`, `test`, `logs` and
  `doctor` refuse a deploy started by another release (`stop` still works).
- Exit code: 3 when no deploy is running, for `status`, `logs` and `test`, or when
  `sync` finds the deploy's Global Controller gone; 4 when Docker can't be used, for
  `deploy`; 1 for any other failure.

## Pick a workflow group

```bash
canyonos list                          # every workflow group on this machine
canyonos select-context my-group  # act on it from any other folder
canyonos select-context --clear        # forget it
```

| Command          | What it does                                                         |
| ---------------- | -------------------------------------------------------------------- |
| `list`           | One line per workflow group: name, `workflow_group_id`, whether it runs      |
| `select-context` | Pick the workflow group commands act on outside a workflow group folder      |

- `list` marks a workflow group deployed without an API key `(unauthenticated)`, and the
  selected one `(selected)`. It lists the workflow groups recorded in
  `~/.canyonos/deployments/`, the Docker ones on this machine.
- `select-context` takes a name, folder name, ID or the start of an ID, as `stop` does.
- Outside a workflow group folder, `stop`, `clean`, `status`, `logs`, `test`, `sync` and
  `curl` act on the selected workflow group when you name none. A name, or running from a
  workflow group folder, always wins.
- A selected workflow group that is no longer deployed is an error until you pick another
  or `--clear` it.

## Stop and clean up

```bash
canyonos stop                  # the only workflow group, or pick from a list
canyonos stop my-group    # a workflow group by name, folder name or ID, from any folder
canyonos stop --all            # every workflow group on this machine
```

| Command | What it does                                                                                                                     |
| ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `stop`  | Remove the workflow group's containers, workspace and network, keeping its images and `.canyon`                                          |
| `clean` | Stop the workflow group, then remove the agents' images and the workflow group's records; each workflow's `.canyon` stays                 |

- Both work from any folder. Name workflow groups by name, folder name, ID or the start of
  an ID; a name two workflow groups share is refused, so use the ID. Names and `--all` don't
  mix.
- Without a name, outside a workflow group folder, they act on the selected workflow group
  (`canyonos select-context`). Else they act on the only workflow group. With more than
  one, they list them: tick the ones you want with space, then press enter. Without a
  terminal they list them and act on none, so pass the names. `clean` also offers this
  folder's workflow group.
- `stop` also stops the dashboard, keeping its history, when no other workflow group runs.
- `clean` removes the workflow group's records in `~/.canyonos/deployments/<workflow group>/`,
  its Redis password among them. It leaves a skill that `convert --scope global`
  installed. When the stop fails or is refused, `clean` removes nothing.
- `stop --all` stops every workflow group on this machine, even one whose folder is deleted.
- `clean --all` removes everything CanyonOS put on this machine, for before you
  uninstall: every workflow group, the dashboard and its data, CanyonOS's images and
  `~/.canyonos`, the API key included. It asks first; `-y` skips the question.
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
  `target` in `workflow_group.yaml`, else `docker`. See
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
