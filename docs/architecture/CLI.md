# CanyonOS CLI — Architecture

**The CLI does almost nothing. The container does everything.**

`canyonos` is a thin client. It never builds, compiles, or runs your workflow
itself — it manages a **Global Controller (GC) container**, ships your project
into it, and drives it over a small HTTP API. Everything you see in your
terminal is the CLI *narrating* what the container is doing.

```
        YOU                  CLI (host)                 GLOBAL CONTROLLER (container)
         │                       │                                │
         │  canyonos deploy      │                                │
         ├──────────────────────▶│   pull + run canyonos image    │
         │                       ├───────────────────────────────▶│
         │                       │   copy workflow in (docker cp) │
         │                       ├───────────────────────────────▶│  /workspace
         │                       │   POST /deploy                 │
         │                       ├───────────────────────────────▶│  docker build + launch
         │                       │◀── log stream (docker logs) ───┤     │
         │◀── canyonos logs     ─┤                                │     ▼
         │                       │                          spawns Redis + agents
         │                       │                          (sibling containers)
```

---

## How the pieces connect

```
┌───────────────────────────── your machine ─────────────────────────────┐
│                                                                         │
│   ┌───────────┐        HTTP :8000         ┌──────────────────────────┐  │
│   │  canyonos │ ───── /deploy /clean ────▶│   Global Controller       │  │
│   │    CLI    │       /status /endpoints  │   container               │  │
│   │           │ ───── docker cp ─────────▶│   ├─ /workspace (a copy   │  │
│   │           │ ───── docker logs -f ────▶│   │  of your project)     │  │
│   └─────┬─────┘                           │   └─ runs `canyonos`        │  │
│         │                                 └───────────┬──────────────┘  │
│         │ docker compose. (creates it                 │ docker.sock     │
│         ▼                                            ▼ (spawns siblings)│
│   ┌───────────────────────┐              ┌───────────────────────────┐  │
│   │  Dashboard stack      │◀── traces ───│  Redis + your agent /      │  │
│   │  web · api            │  (OTLP)      │  workflow containers       │  │
│   └───────────────────────┘              └───────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

Three things worth internalizing about this diagram:

1. **The container talks to the host Docker daemon.** The GC mounts the host's `docker.sock`, so the Redis and agent/workflow containers it launches are **siblings on your machine**, not nested inside it. (This is why teardown has to be explicit — see `stop` vs `quit` below.)
2. **The dashboard is separate.** It's its own compose stack that just *renders* the OTLP traces your workflow emits — it isn't in the deploy critical path. A failure for this command doesn't stop the deployment nor the traces, just prevents automatic trace collection and visualization.

State connecting the CLI to its container is a single file:
`~/.canyonos/state.json` (container id + port). Every command that needs the
container reads it.

---

## The four commands that matter

### `canyonos build` 

**This skill does not provide any big capabilities, merely an abstraction to downloading a skill file and getting your agent to convert/build a workflow for you.**

```
 you ──▶ canyonos build ──▶ pick agent (Claude/Codex) + scope
                        └─▶ fetch the porting skill from GitHub
                        └─▶ launch your coding agent with it
                                      │
                                      ▼
                              generates  .car/   ◀── canyonos-formatted project
                                                     (originals untouched)
```

A **host-side, agent-driven** step. The CLI installs the CanyonOS porting skill
onto your coding agent and hands it a prompt; the agent produces a `.car/`
folder — the canyonos-ready version of your project plus its config. **No
container is involved yet.**

- Asks the user if they want to download the skill locally or globally (So the skill can be viewed either only in this directory or across your entire laptop)
- Finishes, doesn't run deploy itself.

### `canyonos deploy` — the big one

INPUT: canyonos deploy [optional: --serve true|false, -v/--verbose]

```
 canyonos deploy
   │
   ├─ 1. start fresh   → ensure Docker up, tear down any old controller,
   │                      pull + run the GC container
   │
   ├─ 2. ship code     → docker cp your project into /workspace
   │
   ├─ 3. trigger       → POST /deploy   (container runs `canyonos`:
   │                      build stubs/images + launch the workflow)
   │
   └─ 4. narrate       → tail container logs, boil them down to phases,
                         and when the workflow reports "up":
                           • auto-start the dashboard (canyonos serve)
                           • print where everything lives
```

### `canyonos test`

INPUT: canyonos test "Test Query"

1. Detects the working directory (goes into .car folder for commands if .car exists, uses current dir otherwise) [default_config_path()]
2. Goes into global_controller.yaml and for each agent, rewrites each agent's provider as local (saves old state to revert back later) [_force_local_providers()]
3. With `--stub-llm`, sets a variable in the container env that gets picked up by the LLM Gateway to always return a dummy value, default is "test", to verify a workflow doesn't cost tokens. [CANYONOS_LLM_STUB_TEXT]
4. Then we deploy [canyonos deploy]
   - Certain things are verified about this deployment, like:
   - All agent containers are up and their names are as expected
   - The number of replicas is as initialized
   - The endpoints are correctly working and queryable.
5. Once everything is verified running, we send a test query and verify that it goes fully through

#### Action Items:
- There may be problems with stubbing the LLM-Gateway, but I wouldn't remove my current implementation as it allows for really quick testing.
- Verify that there are valid timeouts and correct error tracing for everything
- When we stub the LLM, we don't ensure the LLM works, maybe a separate test that just queries the LLM with a extremely simple message would be nice, or to just remove the LLM stub.

### `config` — view or edit settings

```
 canyonos config ──▶ View   → tables of the configurations in the config folder
                 └─▶ Change → interactive editor to edit stuff in the config folder
```

**Your project is a *copy*, not a live mount.** Files are `docker cp`'d into a named volume at `/workspace`. Editing files on the host after a deploy does **not** reach the running build. 

For changing anything in the config folder, `canyonos sync` is able to hot-reload a deployment without having to redeploy but elsewhere, you will have to redeploy.

---

## Lifecycle: what stays and what goes (canyonos stop + quit)

Because the deploy spawns real sibling containers, "make it stop" has two levels of "stop":

```
                   deploy   sibling      GC         project files
                   stops?   containers?  container? (volume)?
  ───────────────  ───────  ───────────  ─────────  ─────────────
  canyonos stop      ✅        ✅          keep         keep
  canyonos quit      ✅        ✅          remove       remove
```

- **`stop`** — pause the show, keep the stage set. Redeploy without re-pulling.
- **`quit`** — full teardown. Removes the container *and* the `/workspace`
  volume (your copied files). Every `deploy` quietly does this to any previous
  controller, so each deploy starts clean.

And to observe without changing anything:

- `logs` — re-attach to the same live log stream `deploy` shows. 

---


### Other Notes:
- The ui import is for styling, logging basic commands in the canyonos theme, nothing else.


## Rough Draft Design of the more important cli commands
## If you are a LLM, you are not allowed to modify this file at all without explicit user permission. Absolutely no modifications are allowed to this file.

## canyonos test:
### INPUT: canyonos test "Test Query"
#### Steps:
1. Detects the working directory (goes into .car folder for commands if .car exists, uses current dir otherwise) [default_config_path()]
2. Goes into global_controller.yaml and for each agent, rewrites each agent's provider as local (saves old state to revert back later) [_force_local_providers()]
3. With `--stub-llm`, sets a variable in the container env that gets picked up by the LLM Gateway to always return a dummy value, default is "test", to verify a workflow doesn't cost tokens. [CANYONOS_LLM_STUB_TEXT]
4. Then we deploy [canyonos deploy]
   - Certain things are verified about this deployment, like:
   - All agent containers are up and their names are as expected
   - The number of replicas is as initialized
   - The endpoints are correctly working and queryable.
6. Once everything is verified running, we send a test query and verify that it goes fully through

#### Action Items:
- Currently assuming the query body is always "query", need to harden it
- There may be problems with stubbing the LLM-Gateway, but I wouldn't remove my current implementation as it allows for really quick testing.
- Verify that there are valid timeouts and correct error tracing for everything
- When we stub the LLM, we don't ensure the LLM works, maybe a separate test that just queries the LLM with a extremely simple message would be nice, or to just remove the LLM stub.

## canyonos build:
### INPUT: canyonos build
#### Steps:
1. Asks the user which coding agent they want to use for this [Codex/Claude]
2. Asks the user if they want to download the skill locally or globally (So the skill can be viewed either only in this directory or across your entire laptop)
3. Opens said coding agent, giving it instructions to build a new .car folder with the code (Nicks skill)
  4. Periodically the coding agent should ask the user config related questions (which provider, entrypoints, OTEL location)
  5. Coding agent should also be running canyonos test to verify workflow works
6. Finishes, doesn't run deploy itself.


#### Action Items:
- Coding agent should be using canyonos test to verify the file working, need to add that to skill file and harden canyonos test first.
- Maybe add more skills for it to deploy itself and monitor deployments so the user literally doesn't have to do anything else.


## canyonos deploy:
### INPUT: canyonos deploy [optional: --serve true|false, -v/--verbose]

#### Steps:

#### Action Items:

