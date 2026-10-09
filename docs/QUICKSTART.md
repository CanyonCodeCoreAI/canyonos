# Quickstart

Install CanyonOS: `uv tool install canyonos`

For all steps below, run commands from your project folder:
```bash
cd my-project
```

### 1. Convert your project

Skip to Section 2 if you are using a compatible workflow (all workflows in examples/ are valid)

A workflow must follow a certain structure to run on CanyonOS. Thankfully, we have a skill that automatically converts your workflow to a compatible format. Read [workflow design](guides/WORKFLOW_DESIGN.md) for our exact structure.

Our [examples](../examples/) are already in this format, so there's no need to run `canyonos build` on them. Skip to step 2.

`canyonos build` installs the CanyonOS skill into your coding agent and launches it with a prompt to convert your project into `.car/` (CanyonOS's deploy-ready format). We do not modify any of your code. The conversion goes into the .car folder; outside it, build only installs the skill (e.g. `.claude/skills/`) and updates `.env`, `.env.example` and `.gitignore`. As this uses an agent to configure your workflow, it may take a while (2-10 minutes on average).

```bash
canyonos build
```
When it's done, exit back into the terminal. You're now ready to add your credentials.
The agent will also periodically ask questions to configure your deployment file for you. If you want to change configuration details afterwards, go to step 6. If the config suits your taste, continue.

When it's done, exit back into the terminal. You're now ready to add your credentials. 

The agent will also periodically ask questions to configure your deployment file for you. If you want to change configuration details afterwards, go to step 6. If the config suits your taste, continue.

When the conversion succeeds, exiting the agent ends with `✓ Port complete: .car/ passed validation.`

### 2. Add your credentials

Agents read API keys and other secrets from environment variables. `canyonos build` adds the names your project needs to the `.env` file in your project folder, commented out (and lists them in `.env.example`). Uncomment each one and fill in its value before testing:

```bash
# .env
OPENAI_API_KEY=sk-...
```

Using one of our examples? Copy its `.env.example` to `.env` and fill in the values there instead.

`env_file: .env` in `.car/config/global_controller.yaml` passes these to every agent container. Without them, the test fails at the first agent that needs one.

CanyonOS also adds its own `CANYONOS_*` lines to `.env` when the dashboard starts. Leave those as they are.

### 3. Test

Verify the workflow works by deploying everything locally and sending a test query. `canyonos build` saves a sample query taken from your project in `.car/config/test_query.txt`:

```bash
canyonos test "$(cat .car/config/test_query.txt)"
```

To send your own query instead, pass it in quotes: `canyonos test "your query"`. With no query, `hello` is sent.

- Every agent runs locally during the test, whatever its `provider`.
- If the test fails, see [Troubleshooting](guides/TROUBLESHOOTING.md#canyonos-test-fails).
- If a deploy is already running, the query is sent to that deploy instead, and it stays running.
- Add `--timeout SECONDS` to wait longer than the default 300 seconds.

### 4. Deploy

<details>
<summary>Supported dependency versions</summary>

We use the following libraries in CanyonOS and require a minimum version if your code also uses them.

If your code imports any of these, it must allow this version or newer. Older isn't supported, sorry!

`grpcio>=1.76.0` · `protobuf>=6.31.1` · `redis>=3.5` · `flask>=2.3.3` (workflow only)

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

Workflow
curl -X POST http://127.0.0.1:8080/main -H "Content-Type: application/json" -d '{"query": "your query"}'
poll       curl http://127.0.0.1:8080/status/<request_id>
```
- If you forget an endpoint, run `canyonos status` to see them all.
- Every `canyonos deploy` automatically tears down any previous deploy on this machine, from any project, so you can also just redeploy directly.
- If the deploy fails before it comes up, it is torn down automatically (unlike `canyonos test`, which leaves the containers up).

### 5. Sending requests to the workflow

When you deploy, CanyonOS automatically generates a REST API endpoint for the workflow.

To check that the workflow deployed correctly, run `canyonos test "A test query"` to send a query through it.

To send requests manually, use the printed endpoint (`canyonos status` also shows it). The path is your workflow function's name (`main` below), and the JSON body holds that function's arguments (`query` below):

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

- There are three statuses that can be shown:
  - `"status": "pending"` while the workflow runs.
  - `"status": "done"` when it finishes, with your workflow's return value in `result`.
  - `"status": "error"` if it failed.
- Periodically we clean up all finished requests. Once a finished request is cleaned up, this returns `404` with `Request not found`.

### 6. Edit config

If you want to edit any of your config files, you can either edit them directly or through our config command:

```bash
canyonos config
```

Run `canyonos deploy` again to apply your changes.

#### Configuring the Global Controller

Every setting is described in [global_controller.yaml](guides/GLOBAL_CONTROLLER.md).

For `provider: EC2` agents specifically (AMI/IAM/security group requirements, the `ec2:` config block), see [EC2 deployment](guides/EC2.md).

### 7. Stop or quit

```bash
canyonos stop   # stop all containers; keeps CanyonOS's own container and files for the next deploy
canyonos quit   # full teardown — also removes CanyonOS's container, its copy of your project, and the dashboard
```

`quit` leaves your project folder (including `.car/` and `.env`) and the built images in place. Use `canyonos clean` for `.car/`, the images, the installed skill and the `.env` keys `canyonos serve` wrote.

### Clean generated files

Removes the `.car` folder, the CanyonOS skill `canyonos build` installed in this project, the `.env` keys `canyonos serve` wrote (your own lines stay), and every `canyonos-*` Docker image on this machine, including other projects' images.

```bash
canyonos clean
```

## Dashboard

When you run `canyonos deploy`, the dashboard starts automatically at the printed URL (`http://127.0.0.1:8081` by default). To launch only the dashboard without deploying, run `canyonos serve`.

See [Dashboard](guides/DASHBOARD.md) for more information about the information dashboard shows.
