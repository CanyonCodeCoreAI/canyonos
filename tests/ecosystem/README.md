# Ecosystem check

Does CanyonOS work on real projects? Each directory under `projects/` is one
project from [CanyonCodeCoreAI/workflows](https://github.com/CanyonCodeCoreAI/workflows)
pinned to a commit, with its committed `.car/` port. The run clones it, builds the
images from this checkout, deploys, sends the port's `test_query.txt`, then runs
every case under `cases/` that applies. Each case passes or fails; a failing case
leaves its calls, `canyonos doctor` output and container logs under `traces/`.

## Run one project

```bash
uv run pytest tests/ecosystem/cases --project=tradingagents --artifacts-dir=/tmp/eco
```

Put the keys the project declares (`OPENAI_API_KEY`, `TAVILY_API_KEY`) in the
environment or in `tests/ecosystem/.env` (ignored by git). The run builds three
images and deploys the whole project locally: it is meant for CI machines.
While the `workflows` repository is private, set `ECOSYSTEM_GIT_TOKEN` to a
read-only token for it.

## Add a case

Add a test function to a module under `cases/`. Modules run in name order
(`test_1_cli.py` first, `test_9_teardown.py` last). A case that only applies to
some projects is marked `@pytest.mark.trait("<name>")` and runs only for projects
whose `project.yaml` lists that trait.

## Add a project

Create `projects/<name>/` with:

- `project.yaml`: `repo`, `ref` (a full commit SHA), `path` inside the repo, the
  `secrets` the port reads from `.env`, its `traits`, and the query `timeout`.
- `check.py`: `problems(result)` yielding one line per thing wrong with the
  workflow's result. No lines means the result came from the real pipeline.

The dashboard names the project after its folder, so `<name>` is lowercase.
Choosing traits is deliberate: read the port before listing one.

## Report

`report.py` turns the `junit.xml` files and traces of every project into
`report.md`: a pass/fail table and, for each failure, the last call, its output,
the failure text and the container logs. The workflow that runs this check is
private to the internal repository.
