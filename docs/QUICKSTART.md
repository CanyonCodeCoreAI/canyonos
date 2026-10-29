# Quickstart

Install CanyonOS: `uv tool install canyonos`

> **Converting an existing workflow?** Run `canyonos convert` in its folder first. It opens your coding agent with the CanyonOS skill, which writes a CanyonOS version of your project into `.canyon/` (2-10 minutes). Your code is untouched; outside `.canyon` it only installs the skill and updates `.gitignore`. Our [examples](../examples/) are already in [CanyonOS format](guides/WORKFLOW_DESIGN.md).

## Guided first run

Don't have a project yet, or want to see the whole lifecycle once before doing it
yourself? Run this from anywhere:

```bash
canyonos quickstart
```

It picks a sample workflow, sets it up, asks for the one API key it needs, deploys
it, and waits for your first request to come back.

It shows you each command and waits for you to type it before running it. Eight
stages:

| #   | Stage                | Command            | What it does                                                              |
| --- | -------------------- | ------------------ | ------------------------------------------------------------------------- |
| 1   | System Prerequisites | `canyonos doctor`  | Checks Docker, git and everything else a deploy needs                     |
| 2   | Workflow Selection   | —                  | Pick a sample workflow from a menu                                        |
| 3   | Workflow Setup       | —                  | Downloads that workflow                                                   |
| 4   | Workflow Convert     | `canyonos convert` | [Optional] Converts a project into CanyonOS format                        |
| 5   | Environment Config   | —                  | Asks for the API keys the workflow needs and writes them to its `.env`    |
| 6   | Deployment           | `canyonos deploy`  | Builds an image per agent, then starts the workflow                       |
| 7   | Deployment Health    | `canyonos doctor`  | Checks the running deploy: controller, Redis, agents, endpoint, dashboard |
| 8   | First Request        | `curl -X POST …`   | Sends your first request                                                  |

- You need Docker running, git, and an API key.
- Ctrl-C stops the run. Anything already deployed keeps running.
- At the end it offers `canyonos clean` to remove deployment.

## Your own project

Run every command from your project folder:

```bash
cd my-project
```

### 1. Add your credentials

Agents read API keys and other secrets from environment variables. Put them in the `.env` file in your project folder, also after `canyonos convert`. Convert lists the names your project needs in `.canyon/.env.example`; fill in each one in `.env` before testing:

```bash
# .env
OPENAI_API_KEY=sk-...
```

Using one of our examples? Copy its `.env.example` to `.env` and fill in the values there instead.

CanyonOS passes `.env` to every agent replica except the endpoint. Without them, the test fails at the first agent that needs one. `canyonos deploy` warns about any key in `.env.example` that is missing or empty in `.env`.

> **Tip:** Never write secrets in your code or YAML, and keep `.env` out of git. Read them in your agent code with `os.environ["OPENAI_API_KEY"]`, and in config files with `${OPENAI_API_KEY}`.

### 2. Test

Verify the workflow works by deploying everything locally and sending a test query:

```bash
canyonos test "your query"
```

With no query, `hello` is sent. If you ran `canyonos convert`, it saved a sample query from your project: `canyonos test "$(cat .canyon/config/test_query.txt)"`.

- Every agent runs locally during the test, whatever the `provider`.
- If the test fails, see [Troubleshooting](guides/TROUBLESHOOTING.md#canyonos-test-fails).
- If a deploy is already running, the query is sent to that deploy instead, and it stays running. If your files changed since that deploy, the test fails and tells you to run `canyonos deploy` (code) or `canyonos sync` (`config/`) first.
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
- Periodically we clean up all finished requests. A cleaned-up request's result is still kept for a day, then read from the dashboard. If neither has it, this returns `404` with `Request not found`.

### 5. Edit config

If you want to edit any of your config files, you can either edit them directly or through our config command:

```bash
canyonos config
```

Run `canyonos deploy` again to apply your changes.

#### Configuring the Global Controller

Every setting is described in [global_controller.yaml](guides/GLOBAL_CONTROLLER.md).

For `provider: ec2-pool` specifically (`canyonos provision`, AMI/IAM/security group requirements, the `ec2-pool:` config block), see [EC2 deployment](guides/EC2.md).

### 6. Stop

```bash
canyonos stop         # stop this project, and the dashboard if no other project is running
canyonos stop --all   # stop every project on this machine
```

`stop --all` also finds projects whose folder was deleted before `canyonos stop`, whose containers keep holding their ports. `stop` leaves your project folder (including `.canyon/` and `.env`) and the built images in place, so the next deploy is quick. A redeploy leaves the dashboard running. Use `canyonos clean` for `.canyon/`, the images and the installed skill; it never touches `.env`. The project id lives in `global_controller.yaml`; when that file is under `.canyon/`, `clean` removes it too, and the next deploy shows up as a new project on the dashboard.

### Clean generated files

Stops the project if it is deployed, then removes the `.canyon` folder, the CanyonOS skill `canyonos convert` installed in this project, and the Docker images of the agents in this project's `global_controller.yaml`. Other projects' images stay, and `.env` is never touched.

```bash
canyonos clean
canyonos clean --all   # remove everything CanyonOS put on this machine
```

## Dashboard

When you run `canyonos deploy`, the dashboard starts automatically at the printed URL (`http://127.0.0.1:8081` by default). To launch only the dashboard without deploying, run `canyonos serve`.

See [Dashboard](guides/DASHBOARD.md) for more information about the information dashboard shows.
