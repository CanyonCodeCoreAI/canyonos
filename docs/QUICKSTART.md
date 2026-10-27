# Quickstart

Install CanyonOS: `uv tool install canyonos`

> **Converting an existing workflow?** Run `canyonos convert` in its folder first. It opens your coding agent with the CanyonOS skill, which writes a CanyonOS version of your project into `.car/` (2-10 minutes). Your code is untouched; outside `.car` it only installs the skill and updates `.env`, `.env.example` and `.gitignore`. Our [examples](../examples/) are already in [CanyonOS format](guides/WORKFLOW_DESIGN.md).

For all steps below, run commands from your project folder:
```bash
cd my-project
```

### 1. Add your credentials

Agents read API keys and other secrets from environment variables. Put them in the `.env` file in your project folder. If you ran `canyonos convert`, it already added the names your project needs there, commented out (and listed them in `.env.example`); uncomment each one and fill in its value before testing:

```bash
# .env
OPENAI_API_KEY=sk-...
```

Using one of our examples? Copy its `.env.example` to `.env` and fill in the values there instead.

`env_file: .env` in your `global_controller.yaml` passes these to every agent container. Without them, the test fails at the first agent that needs one.

> **Tip:** Never write secrets in your code or YAML, and keep `.env` out of git. Read them in your agent code with `os.environ["OPENAI_API_KEY"]`, and in config files with `${OPENAI_API_KEY}`.

### 2. Test

Verify the workflow works by deploying everything locally and sending a test query:

```bash
canyonos test "your query"
```

With no query, `hello` is sent. If you ran `canyonos convert`, it saved a sample query from your project: `canyonos test "$(cat .car/config/test_query.txt)"`.

- Every agent runs locally during the test, whatever the `provider`.
- If the test fails, see [Troubleshooting](guides/TROUBLESHOOTING.md#canyonos-test-fails).
- If a deploy is already running, the query is sent to that deploy instead, and it stays running.
- Add `--timeout SECONDS` to wait longer than the default 300 seconds.

### 3. Deploy

<details>
<summary>Supported dependency versions</summary>

We use the following libraries in CanyonOS and require a minimum version if your code also uses them.

If your code imports any of these, it must allow this version or newer. Older isn't supported, sorry!

`grpcio>=1.76.0` · `protobuf>=6.31.1` · `redis>=3.5`

</details>

Deploy the project fully, configured by the config files.
When the deploy succeeds, it prints a `POST` endpoint you can send your workflow queries to.

To deploy on EC2, see [EC2 deployment](guides/EC2.md). We currently support only EC2 and local deployments. Stay tuned for more!

```bash
canyonos deploy
```

Once you deploy, a screen will appear showing each agent's CPU, memory, GPU, and replicas. You can change any of them to give any agent more resources or replicas to use for requests, then select **DEPLOY**. Your changes are saved to the config.

Example success message:
```
Deploy is live

Dashboard  http://127.0.0.1:8081

message           curl -X POST http://127.0.0.1:8080/main -H "Content-Type: application/json" -d '{"query": "your query"}'
respond to agent  curl -X POST http://127.0.0.1:8080/answer/<request_id> -H "Content-Type: application/json" -d '{"input": "your answer"}'
check result      curl http://127.0.0.1:8080/status/<request_id>
```
- If you forget the endpoint, run `canyonos status` to see it.
- Every `canyonos deploy` automatically tears down any previous deploy on this machine, from any project, so you can also just redeploy directly.
- If the deploy fails before it comes up, it is torn down automatically (unlike `canyonos test`, which leaves the containers up).

### 4. Sending requests to the workflow

When you deploy, CanyonOS automatically generates a REST API endpoint for the workflow.

To check that the workflow deployed correctly, run `canyonos test "A test query"` to send a query through it.

To send requests manually, use the printed endpoint (`canyonos status` also shows it). The path is the method name of the agent behind the endpoint (`main` below), and the JSON body holds that method's arguments (`query` below):

```bash
curl -X POST http://localhost:8080/main \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Analyze 40% Apple, 35% Microsoft and 25% Nvidia over the last 6 months"
  }'
```
A successful request returns a `request_id`. The workflow runs asynchronously, and the request's status is updated with the answer when it finishes.
To get the result, run:

```bash
curl http://localhost:8080/status/<request_id>
```

- There are four statuses that can be shown:
  - `"status": "pending"` while the workflow runs.
  - `"status": "input_required"` when an agent asks you a question, with the question and the `input_schema` of the answer it expects in `question`, such as `{"input": "str"}`. Answer with those keys at `POST /answer/<request_id>`, such as `{"input": "yes"}`.
  - `"status": "done"` when it finishes, with your workflow's return value in `result`.
  - `"status": "error"` if it failed.
- Periodically we clean up all finished requests. Once a finished request is cleaned up, this returns `404` with `Request not found`.

### 5. Edit config

If you want to edit any of your config files, you can either edit them directly or through our config command:

```bash
canyonos config
```

Run `canyonos deploy` again to apply your changes.

#### Configuring the Global Controller

Every setting is described in [global_controller.yaml](guides/GLOBAL_CONTROLLER.md).

For `provider: EC2` specifically (AMI/IAM/security group requirements, the `ec2:` config block), see [EC2 deployment](guides/EC2.md).

### 6. Stop or quit

```bash
canyonos stop   # stop this project's containers; keeps CanyonOS's own container and files for the next deploy
canyonos quit   # full teardown — also removes CanyonOS's container, its copy of your project, and the dashboard if no other project is running
```

`quit` leaves your project folder (including `.canyon/` and `.env`) and the built images in place. A redeploy leaves the dashboard running. Use `canyonos clean` for `.canyon/`, the images, the installed skill and the `CANYONOS_*` `.env` keys older versions of `canyonos serve` wrote.

### Clean generated files

Removes the `.canyon` folder, the CanyonOS skill `canyonos convert` installed in this project, the `.env` keys `canyonos serve` wrote (your own lines stay), and the Docker images of the agents in this project's `global_controller.yaml`. Other projects' images stay.

```bash
canyonos clean
```

## Dashboard

When you run `canyonos deploy`, the dashboard starts automatically at the printed URL (`http://127.0.0.1:8081` by default). To launch only the dashboard without deploying, run `canyonos serve`.

See [Dashboard](guides/DASHBOARD.md) for more information about the information dashboard shows.
