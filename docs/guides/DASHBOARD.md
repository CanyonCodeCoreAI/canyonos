# Dashboard

The dashboard shows what your deployed workflows are doing: each request with its
traces, model calls and cost, and the logs, errors and resource use behind them. You can
also change prompts, scaling and spend rules while a workflow runs. This page covers the
dashboard a Docker deploy starts on your machine; for the one on a cluster, see
[Kubernetes deployment](KUBERNETES.md#dashboard).

## Open it

`canyonos deploy` starts the dashboard and prints its address: `http://127.0.0.1:8081`,
or the next free port if `8081` is taken. On an EC2 machine, the address uses the
machine's public IP. To start the dashboard without deploying:

```bash
canyonos serve
```

To use another port, set `dashboard_port` in `deployment.yaml`. One dashboard serves
every deployment on the machine, so a dashboard that is already running keeps its port.
[Ports a deploy opens](WORKFLOW_CONFIG.md#ports-a-deploy-opens) says
what happens when the port you set is taken.

`canyonos stop` stops the dashboard when no other deployment is running, and keeps its
history for the next start. `canyonos clean --all` removes it and its data.

## Find a request

Each deployment is listed under **Deployments**, named after its folder. Select it
to open its **Status** page, then go to **Costs** and choose **Per-Query view** to see
each request with its status, cost and latency.

Each request is listed by the `request_id` the endpoint returned. Hover over an ID to see
it in full.

Every page shows the last 7 days at first. Use the time window control to change that.

## What each page shows

The pages are in the order the sidebar lists them under each deployment.

| Page       | What it shows                                                                                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status     | Whether the deployment is running, its routes, replicas, agents, active requests and errors in the last 24 hours, and a button to delete a stopped deployment     |
| Costs      | Query count, spend, tokens and cost per query, in a **Per-Agent view** and a **Per-Query view**                                                                   |
| Traces     | Traffic, p95 latency, and one row per request with its LLM calls, cost and duration. **LLM calls** lists every model call; expand one to see its input and output |
| Errors     | Errors grouped by type and by agent, and the full list                                                                                                            |
| Metrics    | CPU and other resource use for each machine and each agent                                                                                                        |
| Logs       | Log lines, which you can filter by agent and by replica                                                                                                           |
| Prompts    | Each agent function's prompt and its versions, named `<project>.<agent>.<function>`                                                                               |
| Scaling    | Each project's scaling policy, and each of its agents' replicas and load                                                                                          |
| Governance | Each agent, the agents it calls, whether it is up, and its spend against its caps                                                                                 |

Deleting a stopped deployment on **Status** removes it and its telemetry from the
dashboard, and can't be undone. It doesn't touch its folders.

## Change a running workflow

The last three pages change a workflow while it runs:

- **Prompts**: edit a prompt, save it as a new version, and make that version live.
  Edits are not written back to `prompts.yaml`. See
  [Prompt management](PROMPTS.md#change-a-prompt-while-the-workflow-runs).
- **Scaling**: change the thresholds and the minimum and maximum replicas. A change
  applies on the next poll and is lost on the next reload unless you copy it into
  `scaling.yaml`. See
  [Autoscaling](SCALING.md#change-the-policy-while-the-workflow-runs).
- **Governance**: open an agent to choose the agents it requires, set its spend rules
  (refuse calls, or switch model above a threshold), or stop and start it. Rules apply
  on the controller's next poll. See
  [Governance rules](RUNTIME_CONTRACT.md#governance-rules).

## Who can open it

The dashboard asks for API tokens before it shows anything: a read token, a write token,
or both. Make them on the machine that runs the dashboard:

```bash
canyonos token create --scope read     # shows every page
canyonos token create --scope write    # changes prompts, scaling and governance
```

What each token reaches, and how to rotate the key that signs them, is in
[Tokens and keys](AUTHORIZATION.md). Its API, on port `3000`, takes the same tokens from
scripts. The API reads the trusted keys when it starts, so after a change to
`~/.canyonos/auth/trusted/`, run `canyonos serve` to restart it. `canyonos serve
--dangerous-skip-auth` starts it with no token checked, so that anyone who reaches its
port can read and change every deployment on it. Both ports listen on every interface.

The dashboard API also keeps each deployment's Redis password, encrypted with
`REDIS_PASSWORD_ENCRYPTION_KEY`, and won't start without that key (32 characters or
more). `canyonos serve` makes the key once and keeps it in
`~/.canyonos/dashboard/.env`.

## Keep metrics longer

The dashboard keeps metrics at two levels of detail. Ranges of 30 minutes or less read
the raw ticks; longer ranges read the rollups.

| Setting                         | Default | What it keeps                                                |
| ------------------------------- | ------- | ------------------------------------------------------------ |
| `METRICS_RAW_RETENTION_DAYS`    | `3`     | Days of raw ticks, one per poll (every 5 seconds by default) |
| `METRICS_ROLLUP_RETENTION_DAYS` | `120`   | Days of five-minute rollups                                  |

Set them in the shell that starts the dashboard. To change them on a running dashboard,
run `canyonos serve` with the new values, which restarts the dashboard's API with them:

```bash
METRICS_RAW_RETENTION_DAYS=7 METRICS_ROLLUP_RETENTION_DAYS=365 canyonos serve
```

The values are not saved. Each `canyonos serve`, and each `canyonos deploy` that starts
the dashboard, uses the values its shell sets and the defaults for any it doesn't. A
`canyonos deploy` while the dashboard is already running leaves it as it is.

If the dashboard won't start or shows an error, see
[Troubleshooting](TROUBLESHOOTING.md#dashboard).
