# Hello World

The starting point to creating your own workflows!

[Build a workflow from scratch](../../docs/guides/FROM_SCRATCH.md) has the general steps; this README covers running this Hello World workflow.

This workflow does not use an LLM, so no money would be spent from this.

The smallest CanyonOS workflow: a REST endpoint that calls one agent and returns a greeting. It needs no LLM and no API keys, so it's the quickest way to check your setup end to end.

This walkthrough takes it from a fresh copy to a request you can see in the dashboard. For the general steps, see [Build a workflow from scratch](../../docs/guides/FROM_SCRATCH.md).

## What's in it

This folder's `workflow_group.yaml` configures the workflow group, and the workflow,
`helloworld/`, holds the agent code. The first deploy copies `workflow_group.yaml` into the
workflow group's record, `~/.canyonos/workflows/<workflow group>/`, and later deploys read
only that copy.

| File | What it does |
|---|---|
| `workflow_group.yaml` | Where the workflow group runs: on this machine (`provider: local`). |
| `helloworld/agents/hello_agent.py` | `HelloAgent`, with one function, `hello(name)`, that returns `"Hello, <name>! I'm the HelloAgent!"` |
| `helloworld/agents/workflow.py` | `Workflow.main(query)` calls `HelloAgent().hello(name=query)` and returns `{"greeting": ...}` with its result. |
| `helloworld/config/workflow_config.yaml` | What to run: the two agents, and the `endpoint` route that serves `Workflow.main` at `POST /<workflow_id>`, automatically published on the host at `8080` or the next free port. Each agent's `functions` hold its method signatures, and its `name` must match the class name. |
| `helloworld/config/policy.yaml` | Which callers can reach which agents. |

## Before you start

- Docker is running, and `canyonos doctor` passes.
- This example is already in CanyonOS format, so skip `canyonos convert`. It needs no `.env`.
- It runs on this machine (`provider: local`). To run it on EC2, use [helloworld-ec2-assign](../helloworld-ec2-assign/README.md).
- Work on a copy. Deploying fills default resources into `helloworld/config/workflow_config.yaml`.

## 1. Deploy

From this folder, deploy the `helloworld` workflow with an API key of your choice, and
run the other commands from here too. The CLI saves the key, so later deploys reuse it
(see [API key](../../docs/guides/AUTHORIZATION.md)):

```bash
canyonos deploy helloworld --api-key <your api key>
```

After the first deploy, `canyonos deploy --workflow-group <workflow group>` redeploys it from anywhere else; `canyonos list` shows its name.
The dashboard names your workflow group after this folder, `helloworld`.

The first run takes about a minute while it builds the images. It ends with:

```
Deploy is live

Dashboard  http://127.0.0.1:8081

message           curl -X POST http://127.0.0.1:8080/<workflow_id> -H "Authorization: Bearer <your api key>" -H "Content-Type: application/json" -d '{"query": "your query"}'
respond to agent  curl -X POST http://127.0.0.1:8080/answer/<request_id> -H "Authorization: Bearer <your api key>" -H "Content-Type: application/json" -d '{"input": "your answer"}'
check result      curl -H "Authorization: Bearer <your api key>" http://127.0.0.1:8080/status/<request_id>
```

The endpoint starts at 8080 and the dashboard at 8081; each moves to the next free port if needed. Use the URLs printed by `canyonos deploy` or `canyonos status`, replacing 8080 in the requests below with the endpoint's actual port.

## 2. Test it

```bash
canyonos test "World"
```

`canyonos test` sends the saved key itself. A pass ends with:

```
✓ query           1 workflow(s) answered in 0.512s

Output     {
  "greeting": "Hello, World! I'm the HelloAgent!"
}
```

## 3. Send a request

Every request carries the API key. The URL is the one the deploy printed, with this
workflow's `workflow_id`:

```bash
curl -X POST http://127.0.0.1:8080/<workflow_id> \
  -H "Authorization: Bearer <your api key>" \
  -H "Content-Type: application/json" \
  -d '{"query": "World"}'
```

```json
{"request_id": "<request_id>"}
```

Then fetch the result with that id:

```bash
curl -H "Authorization: Bearer <your api key>" http://127.0.0.1:8080/status/<request_id>
```

```json
{"request_id": "<request_id>", "result": {"greeting": "Hello, World! I'm the HelloAgent!"}, "status": "done"}
```

- The JSON body is passed to `main` as arguments, so `{"query": "Ada"}` returns `Hello, Ada! ...`, and `{}` falls back to `World`.
- The path is `/<workflow_id>`, the ID the deploy gave the `helloworld` folder; `canyonos deploy` prints it and keeps it in the record's `workflow_group.yaml`. Only the `endpoint` route is served, so `POST /<name>/HelloAgent/hello` returns `404`.
- A body that isn't JSON returns `{"error": "Invalid JSON in request body"}`.
- A request without the key returns `401`; see
  [Refusals](../../docs/guides/AUTHORIZATION.md#refusals).

## 4. Find it in the dashboard

Open the dashboard URL, then **Workflow groups** → **helloworld** → **Per-Query view**. Your request is listed under its `request_id`, with its status and latency. On **Traces**, expand its row to see `helloworld.Workflow` call `helloworld.HelloAgent.hello`. See [Dashboard](../../docs/guides/DASHBOARD.md) for the other pages.

## 5. Try a policy rule

Rules in `helloworld/config/policy.yaml` decide which agents a request may reach, based on the `_context` you send with it. The rule with the most matching keys wins, and `match: {}` is the fallback. By default every agent is allowed.

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
curl -X POST http://127.0.0.1:8080/<workflow_id> \
  -H "Authorization: Bearer <your api key>" \
  -H "Content-Type: application/json" \
  -d '{"query": "World", "_context": {"origin": "admin"}}'
```

`_context` is removed from the body before `main` is called.

## 6. Stop

```bash
canyonos stop    # remove the deploy, and stop the dashboard if no other workflow group is running
canyonos clean   # also remove the agents' images
```

## If something goes wrong

- A port conflict on an explicitly configured `api_port` stops the deploy. Run `canyonos stop` if an old workflow group still holds the port, remove `api_port` under `endpoint` in the record's `workflow_group.yaml` to restore automatic selection, or choose a free fixed port.
- More symptoms and causes: [Troubleshooting](../../docs/guides/TROUBLESHOOTING.md).
