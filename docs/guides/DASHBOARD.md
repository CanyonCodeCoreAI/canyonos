# Dashboard

The local dashboard shows what your deployed workflow is doing: each request, its traces, logs, errors, model calls, and resource use.

## Opening it

When you run `canyonos deploy`, the dashboard starts automatically and the deploy prints its URL: `http://127.0.0.1:8081`, or the next free port if 8081 is taken. There's no account to create: sign-in is off by default. You can also launch it without deploying:

```bash
canyonos serve
```

To use a different port, set the top-level `dashboard_port` in `config/global_controller.yaml`.

## Sign-in

The dashboard API reads `AUTH_MODE`:

- `none`, the default: there is no sign-in. Anyone who can reach the API or the dashboard port reads every project.
- `password`: the API also needs `JWT_SECRET`. Every project route asks for a bearer token and the dashboard opens on a login screen. The first visitor registers the first account; registration closes after that.

The dashboard that `canyonos deploy` and `canyonos serve` start always runs with `none`; `canyonos` has no setting to change it.

## Finding your run

Your deploy appears under **Projects**, named after your project folder. Open it and choose **Per-Query view** to see each request with its status, cost, and latency. The `request_id` you got from `curl` is that run's trace id, so you can match it there (hover a Query id to see it in full) or on the pages below.

## What each page shows

- **Status** (the project's row in the sidebar): whether it is running, its endpoint, and its replicas. A stopped project can be deleted from here, which removes it and its telemetry from the dashboard.
- **Overview** (the page you land on when you open a project): query count, spend, tokens, and cost per query, by agent or by query.
- **Traces**: traffic and p95 latency, and one row per request with its LLM calls, total cost, and duration. Switch to **LLM calls** to see every model call with its model, agent, tokens, latency, and cost; expand a call to see its input and output.
- **Logs**: log lines, filterable by agent and replica.
- **Errors**: errors grouped by type and by agent, plus the full list.
- **Metrics**: CPU and resource usage for each machine and each agent.
- **Prompts**: your [prompts](PROMPTS.md). Edits apply to the running project until it reloads.
- **Scaling**: each agent's [scaling policy](SCALING.md) (thresholds and min/max replicas). Changes apply to the running deploy right away.

Pages show the last 7 days by default; use the time window control to change it.
