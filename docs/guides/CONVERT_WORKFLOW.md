# Convert an existing workflow

This page is for an agent app you already have, built with a framework such as
LangChain, LangGraph or the OpenAI Agents SDK. `canyonos convert` has your coding agent
turn it into a CanyonOS workflow. Everything it writes goes into a new `.canyon/` folder
beside your code, and your own files stay as they are.

Starting something new? Write it in plain Python instead:
[Start from scratch](FROM_SCRATCH.md) needs no conversion and no coding agent.

## Before you start

- Your app runs: it installs, imports and answers a real request. Conversion doesn't
  fix bugs. [What a workflow needs](WORKFLOW_REQUIREMENTS.md) lists everything else to
  check.
- CanyonOS is [installed](../INSTALLATION.md), and `canyonos doctor` passes.
- A coding agent works in your terminal, such as Claude Code, Codex or Gemini CLI.
  `canyonos convert` supports 14; the [CLI reference](CLI.md#start-a-workflow) lists
  them.

## 1. Convert

```bash
cd my-app
canyonos convert
```

It asks two questions: which coding agent to use, and whether to install the CanyonOS
skill for this folder only or for every project. Then the agent reads your code and
writes the CanyonOS version. This takes 2 to 10 minutes.

To skip the questions, give the answers up front:

```bash
canyonos convert --agent claude --scope local
```

## 2. Check what it wrote

```text
my-app/
├── ...                   # your code, unchanged
├── .env                  # your keys, in step 3
└── .canyon/              # written by canyonos convert
    ├── config/
    │   ├── workflow_config.yaml
    │   ├── test_query.txt
    │   └── ...
    ├── .env.example
    └── ...               # your agents' code
```

| File                                    | What it is                                                |
| --------------------------------------- | --------------------------------------------------------- |
| `.canyon/config/workflow_config.yaml` | The workflow config: the agents it found and how they run |
| `.canyon/config/test_query.txt`         | The query `canyonos test` sends                           |
| `.canyon/.env.example`                  | The names of the keys your code needs                     |

Open the workflow config and check the agents, their `requirements`, `replicas` and
`resources`. [From scratch](FROM_SCRATCH.md#3-list-your-agents-in-the-workflow-config)
explains each setting.

From now on, every `canyonos` command runs from `my-app/` and uses `.canyon`.

## 3. Add your keys

Put the values for the names in `.canyon/.env.example` into a `.env` file in `my-app/`,
beside `.canyon`, not inside it:

```bash
# my-app/.env
OPENAI_API_KEY=sk-...
```

Every agent gets these as environment variables. `canyonos deploy` warns about any key
that is missing.

## 4. Test it

```bash
canyonos test
```

It deploys the workflow locally, sends the query in `test_query.txt` and prints the
result. To send your own query, run `canyonos test "your query"`. If it fails, see
[Troubleshooting](TROUBLESHOOTING.md#canyonos-test-fails).

## 5. Choose where it runs

By default the workflow runs locally, on Docker on your machine. `canyonos target` shows
where it deploys. To run it somewhere else, set that up first:

| Where                | What to do                                                                                                                             | Details                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Locally, with Docker | Nothing; it's the default. If you switched to Kubernetes, `canyonos target docker` switches back                                       | [Local](LOCAL.md)           |
| EC2                  | Run `canyonos provision` to create a machine on AWS to deploy from, copy the workflow there, and set `provider` in the workflow config | [EC2](EC2.md)               |
| Kubernetes           | Run `canyonos target kubernetes` to point the workflow at your cluster; `canyonos cluster up` makes a local one to try it              | [Kubernetes](KUBERNETES.md) |

[Where a workflow deploys](LOCAL.md#where-a-workflow-deploys) explains the `target` and
`provider` settings behind these.

The next steps are the same wherever it runs.

## 6. Deploy

```bash
canyonos deploy
```

It first shows each agent's CPU, memory, GPU and replicas; choose default or edit the
configurations. When it's up, it prints the endpoint and the dashboard address. Send a
request, with the arguments your workflow takes:

```bash
curl -X POST http://127.0.0.1:8080/main \
  -H "Content-Type: application/json" \
  -d '{"query": "your query"}'
```

It answers with a `request_id`. Get the result with:

```bash
curl http://127.0.0.1:8080/status/<request_id>
```

The `status` is `pending` while it runs, then `done` with the result, or `error`. If an
agent asks a question, it is `input_required`; answer at `POST /answer/<request_id>`.

### Watch it on the dashboard

The deploy starts the [dashboard](DASHBOARD.md) at `http://127.0.0.1:8081`. Open it to
see each request, the agents it reached, its model calls and their cost. If the
dashboard isn't running, start it on its own:

```bash
canyonos serve
```

## 7. Stop

```bash
canyonos stop     # remove the containers, keep everything else
canyonos clean    # also delete .canyon, the skill and the agents' images
```

`canyonos clean` deletes the converted workflow. `convert` normally adds `.canyon/` to
`.gitignore`, so git won't keep a copy: remove that line and commit `.canyon` if you
want to keep it.

## Next

- [Configure your workflow](CONFIGURE.md): change settings and apply them to a running
  deploy.
- [Dashboard](DASHBOARD.md): find a request and read what each page shows.
