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

## Run the checks

From the application root, run:

```bash
canyonos validate
```

Every finding blocks and none of them is a warning to carry forward: fix each
and rerun until the command exits 0. Then install what the port declares and
import what the containers import:

```bash
canyonos test --rebuild
```

Confirm with `git status` that nothing outside `.car` changed except the two
files the port is allowed to write: `.gitignore`, which `prepare.py` adds the
artifact to, and `.env.example`, which proxy wiring appends to. Name both in
the handoff. `.env` is written the same way but is normally ignored, so it does
not show up there.

## What a clean run does not prove

`canyonos validate` reads the `.car` source copy. It never builds an image,
installs a distribution, or serves a request, so a clean report is the absence
of the gaps it checks -- not a working deployment. It cannot see what pip
resolved into each image, anything reached only at runtime, or whether the
first request returns an answer. `canyonos test --rebuild` reaches those three,
but only on this machine and only for the one prompt it sends.

Report exactly that much: `canyonos validate` exited 0, and `canyonos test
--rebuild` passed locally against one prompt. "Validation passed" claims a
deployment nobody ran.

Report:

- that the `.car` port validated;
- files created;
- unresolved runtime blockers;
- intentionally omitted unreachable dependencies or source surfaces.

In an attended porting session, stop and ask exactly one direct approval
question:

> `canyonos validate` exits 0 and `canyonos test --rebuild` passes -- locally,
> against one prompt. Run `canyonos deploy` now? This will build images and
> start the deployment.

For an unattended `canyonos build -y`, instead report the validation result and
stop without asking this question. The build command only creates and validates
the port; it never deploys. Do not treat silence, an unattended run, or the
original request to “port” as approval.

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
