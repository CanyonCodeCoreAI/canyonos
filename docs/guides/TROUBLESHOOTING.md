# Troubleshooting

This guide covers problems you may hit and how to fix them. If you think you've found a
bug, search the existing issues first to see if it has already been reported. If not,
file a new issue with as much detail as you can; [Report a bug](#report-a-bug) lists
what to include.

## Health check

Run these from your workflow group folder, the folder that holds `workflow_group.yaml`:

- `canyonos --version` shows which version you have installed.
- `docker info` confirms Docker is running.
- `canyonos doctor` checks that this machine can deploy and that every part of the
  deploy is up.
- `canyonos status` shows whether the workflow group is running, its endpoint and dashboard
  URLs, and any agent that couldn't start. Use these URLs rather than the default
  ports, which change when they're already taken.
- `canyonos logs --no-follow --tail 50` shows recent errors, including some that other
  commands don't print.

## Install and CLI

### Commands say no workflow group is running, but it is up

`! No workflow group is running.`

**Cause:** CanyonOS commands only look in the folder you run them from. If you're in a
workflow folder or a sub-folder, or you renamed, moved or deleted the workflow group folder
after deploying, they can't find the deploy.

**Solution:** go to the workflow group folder and run the command again:

```bash
cd <workflow group folder>
canyonos status    # ✓ Workflow group is running.
```

- **Renamed or moved the folder?** Move it back, run `canyonos stop`, then move it again.
- **Deleted the folder?** Run `canyonos stop <workflow group>` from any folder, or
  `canyonos stop --all`. **Warning:** `--all` stops every workflow group on the machine.

### `new-app` won't run in a folder that looks empty

`Directory is not empty. Run canyonos new-app in an empty directory.`

**Cause:** `new-app` creates the workflow in the current folder and needs it completely
empty, including hidden files such as `.DS_Store` (created by Finder) or `.git`. It
never overwrites your files.

**Solution:** create a new folder for the workflow, or remove a stray `.DS_Store`:

```bash
mkdir my-app && cd my-app && canyonos new-app
# or, if `ls -A` shows only .DS_Store:
rm .DS_Store && canyonos new-app
```

To add CanyonOS to an existing repository, create the workflow in a sub-folder:
`mkdir app && cd app && canyonos new-app`.

### The `quit` command doesn't exist

`invalid choice: 'quit'`

**Cause:** older versions used `canyonos quit`, which has been replaced.

**Solution:** use `canyonos stop` to stop a workflow group (its images are kept), or
`canyonos clean` to also delete its images and records. `canyonos stop --all`
replaces `quit --all`.

### `quickstart` or `provision` stops right away in a script

`needs a terminal`

**Cause:** both commands ask questions and wait for you to type answers. Without a
terminal, nobody can answer, so they stop.

**Solution:** run them yourself in a terminal window. In scripts and CI, use
`canyonos new-app` followed by `cd ..` and `canyonos deploy <name> --workflow-group <name>-group`, which
don't ask questions.

## Configuration

### `sync` succeeds but nothing changes

`✓ Sync complete.`

**Cause:** `sync` copies your files and asks the running workflow group to reload them.
Errors in `workflow_config.yaml` are printed, but errors in other files, such as
`scaling.yaml`, only appear in the logs, and `canyonos validate` doesn't check those
files.

**Solution:** check the logs after every `sync`:

```bash
canyonos sync <workflow folder>
canyonos logs --no-follow --tail 10
```

A good reload logs `Policy rules and <n> config file(s) written`. A failed one logs
`Reload failed:` with the file and line. Fix that line and sync again.

Two kinds of change need `canyonos deploy` instead of `sync`: changes to `.env`, and
changes to `resources:` such as `memory:`.

### Deploy fails because a config file is badly formatted

`CANYON-SCHEMA config/workflow_config.yaml:<line>`
`invalid env file (/workspace/<workflow>/.env): variable '...' contains whitespaces`

**Cause:** a typo or wrong format in one of your workflow's config files. Nothing is
started.

- `workflow_config.yaml`: invalid YAML, a missing key, or a value of the wrong type, for
  example `expected an integer >= 1, got the string 'two'`.
- `.env`: this file is read literally, one `KEY=value` per line. `export`, spaces
  around `=`, quotes and comments after a value all become part of the name or value.
  Quotes cause no error at all; the provider just rejects the key.

**Solution:**

- **For `workflow_config.yaml`:** fix the line the message names, then run
  `canyonos validate <workflow folder>` until it prints `✓ <workflow folder>: clean.`
- **For `.env`:** use plain lines, with comments on their own line:

  ```
  OPENAI_API_KEY=sk-...
  # a comment on its own line
  ```

Then run `canyonos deploy <workflow folder>...`. `sync` doesn't apply `.env` changes.
Paths starting with `/workspace/<workflow>/` in the messages are the same files as in
that workflow's folder.

### Prompt edits in `prompts.yaml` don't apply

**Cause:** once a prompt exists, the dashboard owns it. `prompts.yaml` only adds new
prompts; edits to existing ones are ignored without a message.

**Solution:** change existing prompts in the dashboard: open the prompt, create a new
version and make it live. It applies right away. If you keep prompts in Git, copy the
new text back into `prompts.yaml`.

## Deploy

### Every deploy fails after an earlier deploy failed

`Redis container … is not serving port 6380`

**Cause:** an earlier deploy failed because an agent couldn't load (often
`ModuleNotFoundError`, followed by `✗ Teardown incomplete`). It left the workflow group's
Redis and metrics containers running, and `stop` doesn't remove them.
`canyonos validate` doesn't catch a missing package.

**Solution:**

1. Fix the original error. For a missing package, list it under the agent in
   `config/workflow_config.yaml`:

   ```yaml
   - name: MyAgent
     entrypoint: agents/my_agent.py
     requirements:
       - numpy
   ```

2. Remove the leftover containers, then deploy:

   ```bash
   docker ps -a --filter name=canyonos-<folder name>-
   docker rm -f canyonos-<folder>-<id>-redis-localhost canyonos-<folder>-<id>-metrics-localhost
   canyonos stop
   canyonos deploy <workflow folder>...
   ```

If no other workflow group runs, `canyonos stop --all` removes the leftovers in one step.

### Deploy fails with a long build log

`✗ Deploy failed.`

**Cause:** lines such as `#7 CANCELED` and `context canceled` are noise from Docker
stopping the other build steps. The real cause is always on the line that starts with
`✗ Root Cause:`. The dashboard may be left half running afterwards.

**Solution:** fix what the `Root Cause` line names, then stop the half-running dashboard
without deleting its data, and deploy again:

```bash
docker compose -p canyonos-dashboard stop
canyonos deploy <workflow folder>...
```

**Warning:** use `stop`, not `down`. `down` deletes the dashboard's data.

### Pressing Ctrl-C didn't cancel the deploy

`Stopped monitoring log stream.`

**Cause:** once the deploy has started (after `✓ Global Controller running`), Ctrl-C
only stops the progress output. The deploy keeps running and the workflow group starts
anyway, without the dashboard.

**Solution:** decide what you meant to do:

- **Keep the deploy:** `canyonos serve` starts the dashboard.
- **Cancel it:** `canyonos stop`.
- **Redeploy with changes:** `canyonos deploy` removes the old deploy first, so nothing
  is left over.

### The endpoint or dashboard is on a different port

`Port 8080 is taken, so the endpoint is on 8081.`

**Cause:** another workflow group or program is using a default port, so CanyonOS picks the
next free one: Redis 6379 → 6380, controller 8000 → 8001, endpoint 8080 → 8081,
dashboard 8081 → 8082, dashboard API 3000 → 3001. This is expected.

**Solution:** nothing to fix. Use the URLs that `deploy` prints, or run
`canyonos status`.

### Deploy stops because the workflow group's CA is gone

`<workflow group>'s Redis is still running, but its certificate authority ... is gone`

**Cause:** on Docker, a workflow group's internal traffic is mutual TLS, signed by a CA kept
in `~/.canyonos/deployments/<workflow group>/ca/`. That folder was deleted while the
workflow group's Redis kept running, and Redis would refuse every certificate a new CA signs.

**Solution:** remove the old Redis as the message says, with
`canyonos stop <workflow group>` or `docker rm -f -v <container>`, then deploy again.

### Deploy fails because Redis refuses the workflow group's password

`refuses this workflow group's password`, in the deploy output or `canyonos logs`

**Cause:** the Redis the Global Controller found running holds another password, often
one a crashed deploy left behind.

**Solution:** run `canyonos stop <workflow group>` to remove the old Redis, then redeploy.

## API key

How the key works is in [API key](AUTHORIZATION.md).

### `deploy` or `serve` warns that no API key is set

`No API key is set: the endpoint and the dashboard answer anyone who reaches them. Set one with --api-key <key>.`

**Cause:** this machine has no `~/.canyonos/api_key` and no `CANYONOS_API_KEY`, or the
run passed `--no-api-key`. Nothing is checked.

**Solution:** for anything others can reach, run the command again with a key:

```bash
canyonos deploy <workflow folder>... --api-key <your api key>
```

### The endpoint answers `401`

`auth.missing_key` or `auth.invalid_key`, in the `error_name` of the reply

**Cause:** the request carries no `Authorization: Bearer <your api key>` header, or a
key that is not the one the workflow group was deployed with. After a replace, a workflow group
you have not redeployed still takes the old key.

**Solution:** send the key in the header, or redeploy the workflow group to give it the
machine's current key:

```bash
canyonos deploy <workflow folder>...
```

### The endpoint answers `503` with `auth.not_ready`

`The endpoint is starting; the Global Controller has not published the API key yet`

**Cause:** the endpoint reads the key's hash from the workflow's Redis on every request.
The Global Controller has not written it yet, or Redis doesn't answer.

**Solution:** right after a deploy, wait a few seconds and send it again. If it lasts,
run `canyonos doctor`, and `canyonos logs` for the Global Controller's error.

## Agents and model calls

Agents call model providers with API keys from the workflow's `.env`. CanyonOS passes each
call through its gateway and records usage, but doesn't add keys of its own.

### Model calls fail with HTTP 401

`You didn't provide an API key.` or `Incorrect API key provided`

**Cause:** there's no `.env` in the workflow folder, the key line is commented out, or
the key has quotes around it. Agents read `.env` only when they start, and keys exported
in your shell aren't passed to them.

**Solution:** put the key in `.env` as a plain line, then **deploy**:

```bash
cp .env.example .env
# edit .env: OPENAI_API_KEY=sk-...   (no quotes, no export)
canyonos deploy <workflow folder>...    # from the workflow group folder
canyonos test "replace_with_your_query"
```

### An agent fails with an error from your code

`MyAgent.run failed:` or `CANYON-ADAPTER-CLASS`

**Cause:** a problem in the agent's code:

- `the entrypoint does not parse` is a syntax error.
- `no class named 'MyAgent' at module level` means the class name doesn't match the
  agent's `name:` in `config/workflow_config.yaml`.
- `MyAgent.run failed: ValueError: ...` means your code raised an exception. Only that
  request fails; the agent keeps running.

**Solution:** read the traceback in the agent's log, fix the line it names, then run
`canyonos deploy <workflow folder>...`. Code changes need a full deploy; `sync` only
applies `config/`.

```bash
canyonos logs <workflow>.MyAgent --no-follow --tail 50
```

### Requests fail because the agent stopped

`stopped before it finished: its replica is gone`

**Cause:** the agent's container stopped while handling the request, usually because it
ran out of memory. Each agent is limited to its `resources.memory` value, 512 MB by
default. CanyonOS starts a replacement within seconds.

**Solution:** retry the request. If it keeps happening, check whether the container was
killed for memory:

```bash
docker events --since 10m --until 0s --filter event=oom --format '{{.Time}} {{.Actor.Attributes.name}}'
```

If the agent is listed, raise `memory:` (in MB) in its `resources:` block in
`config/workflow_config.yaml`, for example `memory: 2048`, and run
`canyonos deploy <workflow folder>...`.

### Model calls are blocked by policy (HTTP 403)

`canyonos denied: <agent> is not allowed to use <model>` or `over its $<n> per-request cap`

**Cause:** in `config/llms.yaml`, a model with an `agents:` list allows only those
agents, each with a maximum cost per call. The cost is estimated from the request's
`max_tokens`. The call never reaches the provider.

**Solution:** add the agent to the model's `agents:` list with a high enough cap, or
lower `max_tokens`. Run `canyonos sync <workflow folder>`, then **wait about 5 seconds**
before testing;
the gateway reloads the policy every 5 seconds.

### Your code gets `NOAUTH Authentication required` from Redis

**Cause:** the workflow group's Redis needs a password, and your client connects without it.

**Solution:** connect with the variables CanyonOS sets in every agent:
`CANYONOS_REDIS_HOST`, `CANYONOS_REDIS_PORT` and `CANYONOS_REDIS_PASSWORD`. Inside a
container, `localhost` is the container itself, not Redis.

### `test` times out, but the request keeps running

`The workflow did not finish within <n>s.`

**Cause:** `--timeout` only limits how long the CLI waits. The request keeps running and
still uses model tokens, and it can't be cancelled.

**Solution:** to follow a slow request, send it to the endpoint yourself; the reply
includes its ID:

```bash
curl -s -X POST http://127.0.0.1:8080/<workflow_id> \
  -H "Authorization: Bearer <your api key>" \
  -H "Content-Type: application/json" -d '{"query": "..."}'
curl -s -H "Authorization: Bearer <your api key>" http://127.0.0.1:8080/status/<request_id>
```

### The logs show `database is locked` or `failed to export`

**Cause:** the dashboard isn't running, so the workflow group can't send it monitoring data.
Requests aren't affected.

**Solution:** start the dashboard with `canyonos serve`, or ignore these lines.

## Results of agent calls

### The result holds `<Future Agent.method ...>`

**Cause:** CanyonOS waits for an agent call's result only in code it rewrites. Code it
doesn't rewrite gets the call itself: a module that imports no agent but uses a call it
was handed, a file marked `# canyonos: no-rewrite`, or every file when
`CANYONOS_LAZY_VALUES=0` is set.

**Solution:** import the agent's class in that module, or call `.resolved()` there for
the result as its declared type. See
[Results of agent calls](RUNTIME_CONTRACT.md#results-of-agent-calls).

### A result is text that looks like a dict

**Cause:** `.value()` always returns the stored text, and so does a call to a function
with no `returns` type.

**Solution:** use the result without `.value()`, and declare `returns` for the function
under `functions` in `config/workflow_config.yaml`.

### Calls to several agents run one at a time

**Cause:** each call's result is used before the next call is made, as in a generator
such as `sum(agent.count(x=x) for x in items)`. A call returns at once, but the first
line that uses its result waits for it.

**Solution:** make every call first, in a list, then use the results:

```python
counts = [agent.count(x=x) for x in items]
total = sum(counts)
```

## Dashboard

The dashboard keeps its data in a Docker volume that survives `canyonos stop` and
`canyonos clean`. It's only lost through `docker compose ... down` or
`canyonos clean --all`.

### The dashboard won't start because its port is taken

`Port <n> is taken. Change dashboard_port, or remove it so CanyonOS picks a free port.`

**Cause:** you set `dashboard_port` in `workflow_group.yaml`, and another
program holds that port. A port you set is never moved; without the setting, the
dashboard moves to the next free port on its own.

**Solution:** remove `dashboard_port` so CanyonOS picks a free port, or free the port:

```bash
lsof -nP -iTCP:<port> -sTCP:LISTEN    # find what holds the port, then stop it
canyonos serve
```

### The dashboard keeps running after `stop`

**Cause:** you started the dashboard on its own with `canyonos serve`. `stop` only stops
the dashboard as part of stopping a workflow group, so it prints `! No workflow group is running.`
and leaves it up.

**Solution:** stop it directly. Its data is kept, and `canyonos serve` starts it again
later:

```bash
docker compose -p canyonos-dashboard stop
```

**Warning:** use `stop`, never `down`. `down` deletes the dashboard's data, so the next
`serve` starts empty.

### A copied workflow group folder doesn't get its own dashboard entry

`Registered <another deployment> with the dashboard`

**Cause:** the first deploy writes a `workflow_group_id:` line into `workflow_group.yaml`, and
the dashboard identifies workflow groups by it. A copied folder, or a clone of a repo where
that file was committed after a deploy, has the same ID, so both workflow groups' data is
mixed.

**Solution:** in the copy, delete the `workflow_group_id:` line from `workflow_group.yaml` and
run `canyonos deploy <workflow folder>...`. The copy gets a new ID and shows up as its
own workflow group.

### The dashboard sends you back to the sign-in screen

**Cause:** the dashboard API refused the key the browser holds (`auth.invalid_key`,
`401`), usually because the machine's key was replaced.

**Solution:** sign in with the current key, or run `canyonos dashboard` on the machine
that holds it.

### The dashboard shows `canyonos.redis_auth_failed` for a workflow group

`This workflow group's Redis refused the password the dashboard holds for it.`

**Cause:** the password the dashboard holds for the workflow group no longer matches the
workflow group's Redis.

**Solution:** run `canyonos deploy <workflow folder>...` from the workflow group's folder.
The deploy registers the current password with the dashboard.

## Kubernetes

Kubernetes deploys don't support multi-folder workflow groups yet.

### Deploy times out because the cluster runs out of memory

`Not ready after 10 minutes (... has no node to run on: 0/2 nodes are available: 1 Insufficient memory ...)`

**Cause:** each agent reserves memory (512 MB by default), and the cluster doesn't have
enough for all of them. Workflows with many agents hit this first.

**Solution:** stop other workflow groups, raise Docker Desktop's memory
(**Settings → Resources**), or lower `memory:` for your agents in
`config/workflow_config.yaml` to fit your hardware. Then redeploy:

```bash
canyonos stop
canyonos deploy
```

### Deploy fails because the image push is refused

`failed to push <registry>/<image>: ... connect: connection refused`

**Cause:** the workflow group's `registry:` points to the wrong address or port, so there's no
registry there to receive the images.

**Solution:** check that the address and port in the `registry:` line of
`workflow_group.yaml` are right, then deploy. With `canyonos cluster up`, the
registry is `localhost:5001`.

## Stopping and reset

### `stop` takes several minutes

`Tearing down...`

**Cause:** `stop` usually takes about 8 seconds, but it waits up to 3 minutes for
running requests to finish. Requests still running after that are cut off.

**Solution:** wait, or, if you don't need the running requests, remove the busy agent
containers first so `stop` finishes right away:

```bash
docker ps --format '{{.Names}}' | grep canyonos-<folder>-
docker rm -f <busy agent container>
canyonos stop
```

### `clean` fails for a workflow with a database agent

`unable to delete … (must be forced)`

**Cause:** the database agent's image is another name for a shared public image such as
`postgres:16-alpine`, which other containers also use, and `clean` tries to delete it.

**Solution:** remove only the workflow group's name for the image, then run `clean` again:

```bash
docker images | grep canyonos-<folder>-
docker rmi canyonos-<folder>-<id>-<workflow>--<database agent name>:latest
canyonos clean
```

### `clean` leaves `~/.canyonos/deployments/<workflow group>/`

**Cause:** `clean` stops the workflow group first. When that stop fails or is refused,
`clean` removes nothing.

**Solution:** fix what the stop reported, or name the workflow group, as in
`canyonos clean <workflow group>`, to force it, then run `clean` again.

### Reset options: try these in order

Start at step 1 and stop at the first step that fixes your problem.

1. **Retry** after checking that `docker info` works.
2. **Stop the workflow group:** `canyonos stop` in its workflow group folder. Images and
   dashboard data are kept.
3. **Stop the dashboard:** `docker compose -p canyonos-dashboard stop`, if `stop` left
   it running. Its data is kept.
4. **Remove a failed deploy's leftovers:** `docker rm -f` the workflow group's
   `-redis-localhost` and `-metrics-localhost` containers, then `canyonos stop`. Find
   them with `docker ps -a --filter name=canyonos-<folder name>-`.
5. **Stop everything:** `canyonos stop --all` stops every workflow group on the machine,
   including ones whose folder is gone, and the dashboard.
6. **Remove one workflow group:** `canyonos clean` in its workflow group folder also deletes its
   images and records.
7. **Remove CanyonOS completely:** `canyonos clean --all`. **Warning:** this deletes
   every workflow group, the dashboard and its data, all CanyonOS images, and `~/.canyonos`.
   Use it only before uninstalling.

## Report a bug

Include these so the team can reproduce it:

- The output of `canyonos --version`, `canyonos status`, `canyonos doctor` and
  `docker info`
- Your OS, CPU (Intel, Apple Silicon or ARM) and Python version
- The exact command you ran and the full error text
- For deploy problems, the output of `canyonos deploy -v`. For runtime or config
  problems, `canyonos logs --no-follow --tail 100`
- Any log file the error points to, such as
  `~/.canyonos/dashboard/logs/serve-<timestamp>.log`
