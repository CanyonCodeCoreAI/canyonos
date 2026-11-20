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
skill for this folder only or for every workflow. Then the agent reads your code and
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

From now on, every `canyonos` command you give `my-app/` uses `.canyon`.

## 3. Add your keys

Put the values for the names in `.canyon/.env.example` into a `.env` file in `my-app/`,
beside `.canyon`, not inside it:

```bash
# my-app/.env
OPENAI_API_KEY=sk-...
```

Every agent gets these as environment variables. On Docker, `canyonos deploy` warns
about any key that is missing.

## 4. Choose where it runs

By default the workflow runs locally, on Docker on your machine. To run it somewhere
else, set that up first:

| Where                | What to do                                                                                                                             | Details                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Locally, with Docker | Nothing; it's the default. If you switched to Kubernetes, set `target: docker` in `workflow_group.yaml`                                | [Local](LOCAL.md)           |
| EC2                  | Run `canyonos provision` to create a machine on AWS to deploy from, copy the workflow there, and set `provider` in `workflow_group.yaml`   | [EC2](EC2.md)               |
| Kubernetes           | Set `target: kubernetes` in `workflow_group.yaml` for your cluster; `canyonos cluster up` makes a local one to try it                  | [Kubernetes](KUBERNETES.md) |

[Where a workflow deploys](LOCAL.md#where-a-workflow-deploys) explains the `target` and
`provider` settings behind these.

The next steps are for Docker and EC2. On Kubernetes, `canyonos deploy` builds and
starts it in the cluster without the resource step below; see
[Kubernetes](KUBERNETES.md). Kubernetes deploys don't support multi-folder workflow groups
yet.

## 5. Deploy

From `my-app/`, deploy it as a workflow group of its own:

```bash
canyonos deploy . --api-key <your api key>
```

The workflow group's `workflow_group.yaml` and the CLI's state for it go in its record,
`~/.canyonos/workflows/my-app-<id>/`, not in `my-app/`, and so does a copy of
`.canyon/config/`, in `<workflow>/config/`. That copy is the one deployed from now on:
edit it there, not in `.canyon/config/`. Run the other commands from `my-app/`.

It first shows each agent's CPU, memory, GPU and replicas. Choose **1. Deploy**, or
**2. Configure an agent** to change them first. What it deploys with, defaults included,
is saved in the record's workflow config. `--api-key` sets the key every request must carry;
later deploys reuse it (see [API key](AUTHORIZATION.md)). When it's up, it prints the
endpoint and the dashboard address. Then send it the query in `test_query.txt`:

```bash
canyonos test
```

It prints the result. To send your own query, run `canyonos test "your query"`. If it
fails, see [Troubleshooting](TROUBLESHOOTING.md). Or send a request yourself, with the
arguments your workflow takes and the API key:

```bash
curl -X POST http://127.0.0.1:8080/my-app/<agent>/<method> \
  -H "Authorization: Bearer <your api key>" \
  -H "Content-Type: application/json" \
  -d '{"query": "your query"}'
```

It answers with a `request_id`. Get the result with:

```bash
curl -H "Authorization: Bearer <your api key>" http://127.0.0.1:8080/status/<request_id>
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

## 6. Stop

```bash
canyonos stop     # remove the containers, keep everything else
canyonos clean    # also delete the agents' images and the workflow group's records
```

`convert` normally adds `.canyon/` to `.gitignore`, so git won't keep a copy: remove
that line and commit `.canyon` if you want to keep it.

## Next

- [Configure your workflow](CONFIGURE.md): change settings and apply them to a running
  deploy.
- [Dashboard](DASHBOARD.md): find a request and read what each page shows.
