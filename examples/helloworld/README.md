# Hello World

The starting point to creating your own workflows!

The guides/QUICKSTART.md has more general information on running a workflow, but this doc is tailored specifically towards getting this Hello World workflow up and running.

This workflow does not use an LLM, so no money would be spent from this.

The smallest CanyonOS workflow: a REST endpoint that calls one agent and returns a greeting. It needs no LLM and no API keys, so it's the quickest way to check your setup end to end.

This walkthrough takes it from a fresh copy to a request you can see in the dashboard. For the general steps, see the [Quickstart](../../docs/QUICKSTART.md).

## What's in it

| File | What it does |
|---|---|
| `agents/hello_agent.py` | `HelloAgent`, with one function, `hello(name)`, that returns `"Hello, <name>! I'm the HelloAgent!"` |
| `agents/hello_agent.yaml` | The agent's name and function signature. The class name must match `agent.name` here and `name` in `global_controller.yaml`. |
| `workflow/example_workflow.py` | `main(query)` calls `HelloAgent().hello(name=query)`, waits for it with `.value()`, and returns `{"greeting": ...}`. `deploy(main, port=8080)` serves it at `POST /main`. |
| `config/global_controller.yaml` | What to run: the agent and workflow, both on `provider: local`. |
| `config/policy.yaml` | Which callers can reach which agents. |

## Before you start

- Docker is running, and `canyonos doctor` passes.
- This example is already in CanyonOS format, so skip `canyonos build`. It needs no `.env`.
- Work on a copy. Deploying writes into the project folder: it fills default resources into `config/global_controller.yaml`, and the dashboard adds a `.env` with `CANYONOS_*` lines.

```bash
cd helloworld
```

The dashboard names your project after this folder, `helloworld`.

## 1. Test it

```bash
canyonos test "World"
```

The first run takes about a minute while it builds the images. A pass ends with:

```
✓ deploy          Global Controller on port 8000
✓ verify_runtime  2 agent(s) up
✓ query           answered in 23.199s

Output     {
  "greeting": "Hello, World! I'm the HelloAgent!"
}
```

A passing test tears everything down again, including the dashboard.

## 2. Deploy

```bash
canyonos deploy
```

It ends with:

```
Deploy is live

Dashboard  http://127.0.0.1:8081

Workflow
curl -X POST http://127.0.0.1:8080/main -H "Content-Type: application/json" -d '{"query": "your query"}'
poll       curl http://127.0.0.1:8080/status/<request_id>
```

The dashboard port moves to the next free one if 8081 is taken, so use the URL it prints.

## 3. Send a request

```bash
curl -X POST http://127.0.0.1:8080/main \
  -H "Content-Type: application/json" \
  -d '{"query": "World"}'
```

```json
{"request_id": "<request_id>"}
```

Then fetch the result with that id:

```bash
curl http://127.0.0.1:8080/status/<request_id>
```

```json
{"request_id": "<request_id>", "result": {"greeting": "Hello, World! I'm the HelloAgent!"}, "status": "done"}
```

- The JSON body is passed to `main` as arguments, so `{"query": "Ada"}` returns `Hello, Ada! ...`, and `{}` falls back to `World`.
- The path is the function's name. `POST /hello` returns `404`.
- A body that isn't JSON returns `{"error": "Invalid JSON in request body"}`.

## 4. Find it in the dashboard

Open the dashboard URL, then **Projects** → **helloworld** → **Per-Query view**. Your request is listed under its `request_id`, with its status and latency. On **Traces**, expand its row to see the workflow call `HelloAgent.hello`. See [Dashboard](../../docs/guides/DASHBOARD.md) for the other pages.

Each redeploy starts the dashboard's history fresh.

## 5. Try a policy rule

Rules in `config/policy.yaml` decide which agents a request may reach, based on the `_context` you send with it. The rule with the most matching keys wins, and `match: {}` is the fallback. By default every agent is allowed.

Remove `HelloAgent` from the fallback rule:

```yaml
  - match: {}
    access:
      - Workflow
```

Redeploy, then send the same request. It now fails:

```json
{"error": "PolicyDenied", "request_id": "...", "status": "error"}
```

A request that sends `_context` matching the admin rule still gets through:

```bash
curl -X POST http://127.0.0.1:8080/main \
  -H "Content-Type: application/json" \
  -d '{"query": "World", "_context": {"origin": "admin"}}'
```

`_context` is removed from the body before `main` is called.

## 6. Stop

```bash
canyonos stop   # stop the agents and the dashboard
canyonos quit   # remove everything CanyonOS started
```

## If something goes wrong

- `Port 8080 is already in use`: another deploy or app holds it. Run `canyonos quit`, or change `api_port` on the workflow entry.
- More symptoms and causes: [Troubleshooting](../../docs/guides/TROUBLESHOOTING.md).
