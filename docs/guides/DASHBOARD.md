# Dashboard

The local dashboard shows what your deployed workflow is doing: each request, its traces, logs, errors, model calls, and resource use.

## Opening it

When you run `canyonos deploy`, the dashboard starts automatically and the deploy prints its URL: `http://127.0.0.1:8081`, or the next free port if 8081 is taken. It signs you in by itself, so there's no account to create. You can also launch it without deploying:

```bash
canyonos serve
```

To use a different port, set `dashboard_port` on the workflow entry in `.car/config/global_controller.yaml`.

## Finding your run

Your deploy appears under **Projects**, named after your project folder. Open it and choose **Per-Query view** to see each request with its status, cost, and latency. The `request_id` you got from `curl` is that run's trace id, so you can match it there (hover a Query id to see it in full) or on the pages below.

## What each page shows

- **Overview** (the page you land on when you open a project): query count, spend, tokens, and cost per query, by agent or by query.
- **Traces**: traffic and p95 latency, and one row per request. Expand a row to see each agent call on a timeline.
- **Logs**: log lines, filterable by agent and replica.
- **Errors**: errors grouped by type and by agent, plus the full list.
- **Metrics**: CPU and resource usage for each machine and each agent.
- **LLM**: every model call with its model, agent, tokens, latency, and cost. Expand a row to see the input and output.
- **Prompts**: your [prompts](PROMPTS.md). Edits apply to the running project until it reloads.
- **Scaling**: each agent's [scaling policy](SCALING.md) (thresholds and min/max replicas). Changes apply to the running deploy right away.

Pages show the last 7 days by default; use the time window control to change it.
