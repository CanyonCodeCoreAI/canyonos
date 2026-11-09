# E2E check

Does CanyonOS work on real projects? The check deploys each project under
`projects/` with the CLI and images from this checkout and runs every case that
applies to it. It also runs the `scenarios/`, which stage and deploy their own
projects. Each case passes or fails. A failing case leaves its calls, the
`canyonos doctor` output and the container logs under `traces/<case>/`, or
`traces/setup__<case>/` when it failed in setup. Later cases that fail on the same
setup error only point to that first trace.

| Folder | What it holds |
|---|---|
| `harness.py` | One runner for every CLI command, HTTP request and Docker command, recorded for traces. It also stages projects, finds the endpoint, sends queries and builds images. |
| `fleet.py` | What cases read from a running deploy: the project's Redis, the replicas the routing table sends calls to, a request's calls, and each replica's container. |
| `projects/<name>/` | One project: a `project.yaml` and a `check.py` whose `problems(result, *, query=None, request_id=None)` says what is wrong with a workflow result for that query and request. |
| `cases/` | Assertions against one deployed project, picked with `--project`. Modules run in name order, and `test_9_teardown.py` runs last. |
| `scenarios/` | Checks that need no project or more than one deploy: `canyonos validate` refusing broken manifests, the `canyonos new-app` starter, two projects on one dashboard, and the governance rules on `pr_review`. |
| `report.py` | Writes the run's `report.md` from every project's `junit.xml`, `collected.json` and traces. |
| `gateway_check.py` | Copied into an agent replica by a case to check the LLM gateway from inside. |
| `ec2_pool.sh`, `ec2_pool/` | The EC2 pool check. It is manual, needs AWS access to run machines, and no workflow runs it. |

## Run it

```bash
uv run pytest tests/e2e/cases --project=helloworld
uv run pytest tests/e2e/scenarios
```

Put the secrets a project declares in the environment or in `tests/e2e/.env`,
which git ignores and which is read the way the CLI reads its own `.env`. Portfolio needs `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`
for Bedrock in `us-east-1`, and so does the governance scenario, which also reads
`BEDROCK_SWITCH_MODEL_ID` (default `meta.llama3-8b-instruct-v1:0`). TradingAgents
needs `OPENAI_API_KEY`. Without the
`CANYONOS_*_IMAGE` variables the run builds the core, api and web images itself.

The CLI runs with your HOME, so a run writes to your `~/.canyonos` like any
`canyonos` command: it has no other setting for that folder. `CANYONOS_USAGE_URL`
is set to `off`, so a run never sends usage events.

With `--artifacts-dir`, the run writes `collected.json`, `junit.xml`, `calls.jsonl`
and `traces/` there. `python3 tests/e2e/report.py <dir> report.md --title <title>
--expect <project>...` counts each project's cases as passed, failed, not run or
skipped. A collected case missing from `junit.xml`, as a run cut short leaves it,
is not run, and an expected project with no results fails.

In CI, `.github/workflows/e2e.yml` runs every project not marked `release_only`,
plus the scenarios, on each pull request. Before a release, run that workflow by
hand with `release` to add the rest. Run by hand with project names, it runs only
those projects and skips the scenarios. It does not run on pull requests from forks
or from Dependabot, which get no secrets.

## Add a project

Create `projects/<name>/`. The dashboard names the project after the folder, so
`<name>` is lowercase. It holds:

- `project.yaml`:
  - `source`: a folder of this repo (`examples/helloworld`), or `{repo, ref, path}` for a GitHub repo pinned to a full commit SHA.
  - `port`: a `.canyon` folder next to it, copied over the source.
  - `overlay`: files next to it that replace files of the source.
  - `query`: the test query, a string or, for an argument of another type, YAML. Without it, the port's `config/test_query.txt` is used.
  - `cli_query`: the query as `canyonos test` passes it on the command line, for a workflow that reads command-line text in its own form (`pr_review`'s `title\ndiff`). Without it, the cases send `query`, as JSON when it is not a string.
  - `secrets` and `env`: what goes in the staged `.env`.
  - `traits`, `timeout`, and `release_only`.
- `check.py`: `problems(result, *, query=None, request_id=None)` yielding one line per thing wrong with the result. No lines means the result came from the real pipeline.

## Add a case

Add a test function to a module under `cases/`. A case that applies to only some
projects is marked `@pytest.mark.trait("<name>", ...)`. It runs only for projects
whose `project.yaml` lists every trait it names. A trait no `project.yaml` lists
stops the run with a usage error:

| Trait | The project |
|---|---|
| `llm` | calls a model, so tokens, cost and model calls show up in the dashboard |
| `quick` | answers a query in seconds, so a query can be sent again |
| `text-query` | its endpoint takes any text, and its `check.py` says what the result for it must be |
| `failing-query` | has a `FAILING_QUERY` in its `check.py` whose error names the agent that failed |
| `logs` | keeps `logs:` on in its manifest, so its replicas' logs reach the dashboard |
| `prompts` | has a `prompts.yaml` |
| `context-propagation` | returns the request context each caller saw |

Read the project before you list a trait for it.
