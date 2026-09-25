# Validate, hand off, and optionally deploy

**When:** after runtime code and configuration are complete.

**Output:** a clean validation report and a stopped porting workflow. Deployment
is a separate action that requires explicit approval.

## Validation scope

Validate only contracts that authored port files can violate and CanyonOS does
not fail closed on—for example declaration/adapter bindings, generated-stub
imports, workflow call shape, and per-image dependency coverage.

Do not add duplicate checks for postconditions strongly guaranteed by code:

- a successful `prepare.py` run already creates the artifact directories,
  rejects source symlinks, applies exclusions, and installs the copy atomically;
- `canyonos config` owns the structure of configuration it generates;
- deploy preflight owns checks that already fail before resources are changed.

Treat required inputs such as a readable manifest and `.car/app` as validator
preconditions, not independent port rules. If a guarantee changes in CanyonOS,
change the owning code rather than maintaining a parallel rule in prose and
validation.

## Run the gap validator

From the application root, run:

```bash
python3 <skill_dir>/validate.py .car
```

Fix every `ERROR` and rerun until the command exits 0. Review every warning;
pause for blockers and surface required developer actions in the handoff.
Keep non-actionable diagnostic details in progress updates.

Confirm with `git status` that nothing outside `.car` changed except the two
files the port is allowed to write: `.gitignore`, which `prepare.py` adds the
artifact to, and `.env.example`, which proxy wiring appends to. Report these
changes in progress updates. `.env` is written the same way but is normally
ignored, so it does not show up there.

## What a clean run does not prove

`validate.py` reads the `.car` source copy. It never builds an image, installs
a distribution, or serves a request, so a clean report is the absence of the
gaps it checks -- not a working deployment. It cannot see what pip resolved
into each image, anything reached only at runtime, or whether the first request
returns an answer. A ModuleNotFoundError at container start and an
AttributeError on the first call both survive an exit-0 run.

## Final handoff

Keep the final message short and actionable. Do not repeat the progress
checklist, file inventory, implementation details, or raw validator output.
Use the developer's language. Do not ask whether to deploy or run additional
commands as part of the handoff, in attended or unattended sessions.

**Success:** only after gap validation exits 0 and no readiness blocker
remains, report that the porting work for `canyonos build` succeeded. This
means `.car` was prepared and validated, not that images were built or a live
request passed. When running inside the build's coding session, do not claim
the parent CLI has exited successfully; it performs its final check after the
session ends.

Name the required environment keys from the source and `.env.example`, and
the configured `env_file` path (normally `.env`). Tell the developer to fill
them before the operations that require them; never show secret values or
claim their presence was verified. `canyonos test` stubs LLM calls by default;
real model calls and deployment need provider credentials, and external tools
may still need their own keys during testing.

Offer only these next steps: quit the coding session to return to the CLI,
or run `canyonos test` / `canyonos deploy` from the application root. For example,
substituting the actual required keys and env file:

> Porting for `canyonos build` succeeded; `.car` passed static validation.
> Before deployment or real model calls, set `OPENAI_API_KEY` in `.env`.
> Next: quit this coding session, or run `canyonos test` for a local check /
> `canyonos deploy` to deploy.

**Blocked:** say the build is paused and identify the concrete source problem
with its file/call-path evidence. Give the developer the specific change
needed before retrying `canyonos build`, and link the relevant section of
[Preparing an Agent App for CanyonOS](https://github.com/CanyonCodeCoreAI/canyonos/blob/5cd4fa8c51082e414aad64e27283ba50c27c579f/docs/CANYONIZATION-APP-READINESS.md).
Do not use the success message or suggest test/deploy. For example:

> Build paused: `agent.py` starts Docker for required code execution. Move
> execution to an external sandbox service, then rerun `canyonos build`.
> See [readiness guide: Docker inside the application](https://github.com/CanyonCodeCoreAI/canyonos/blob/5cd4fa8c51082e414aad64e27283ba50c27c579f/docs/CANYONIZATION-APP-READINESS.md#2-do-not-require-docker-inside-the-application).

The build command only creates and validates the port; it never deploys. Do
not treat silence, an unattended run, or the request to port as deploy approval.

## Deploy only after approval

If the user explicitly approves, run from the application root:

```bash
canyonos deploy
```

Do not run a standalone build first: `canyonos deploy` performs both build and
deployment. Do not add probing, deployment debugging, or cleanup to the porting
flow.

If an approved deploy fails during build, startup, or a request, read
`troubleshooting.md`. Read `runtime-contract.md` when a validator finding or
runtime mechanism needs explanation.
