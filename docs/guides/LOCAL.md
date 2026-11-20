# Local workflow group

A local deploy runs the whole workflow as Docker containers on the machine that runs
`canyonos deploy`. It is the default, so a `workflow_group.yaml` that sets neither `target`
nor `provider` deploys this way. This page covers what a deploy starts, the ports it
opens, and how to check, change and stop it.

You need CanyonOS [installed](../INSTALLATION.md) and Docker running; `canyonos doctor`
checks Docker.

## Where a workflow deploys

Two settings in the workflow group's `workflow_group.yaml`, in its record
`~/.canyonos/workflows/<workflow group>/`, decide where a workflow runs:

- `target` picks what runs it: `docker`, CanyonOS on the machine that runs
  `canyonos deploy` (the default), or `kubernetes`, the CanyonOS operator on a cluster.
- `provider` picks where the agents run, and only applies to the `docker` target:
  `local` (the default), or EC2 with `ec2-pool` or `ec2-assign`.

| Deploy to                   | `target`     | `provider`                 | Set it with                       |
| --------------------------- | ------------ | -------------------------- | --------------------------------- |
| Locally, with Docker        | `docker`     | `local`                    | Nothing; it's the default         |
| [EC2](EC2.md)               | `docker`     | `ec2-pool` or `ec2-assign` | `provider` in `workflow_group.yaml`   |
| [Kubernetes](KUBERNETES.md) | `kubernetes` | not used                   | `target` in `workflow_group.yaml`     |

Kubernetes deploys don't support multi-folder workflow groups yet.

## Deploy

From the workflow folder (for a converted workflow, the folder that holds `.canyon`), or
from any folder with its path:

```bash
canyonos deploy . --api-key <your api key>
```

The first deploy makes the workflow group's record, `~/.canyonos/workflows/<workflow
group>/`, with its `workflow_group.yaml`, starting from the one in the folder it runs
from when there is one, and a copy of each workflow's `config/`. Run the other commands, a redeploy included, from the workflow
folder: `canyonos deploy .`. From any folder, `canyonos deploy --workflow-group
<workflow group>` redeploys it.

`--api-key` sets the key every request to the endpoint and the dashboard must carry. The
CLI saves it to `~/.canyonos/api_key` and later deploys reuse it, so pass it once.
Without a key, the deploy warns and anyone who reaches the endpoint can use it. See
[API key](AUTHORIZATION.md).

1. It checks each workflow: it warns about keys in `.env.example` that `.env` leaves
   missing or empty, and stops on any problem `canyonos validate` finds.
2. It shows each agent's CPU, memory, GPU and replicas. Choose **1. Deploy**, or
   **2. Configure an agent** to change them first.
3. It builds an image per agent and starts the Global Controller, Redis, the agents'
   replicas, the endpoint and, if it isn't running yet, the [dashboard](DASHBOARD.md).
   With `deploy_mode: toy`, each workflow's agents run in one replica with no image
   build, and the dashboard doesn't start: run `canyonos serve` for it.
4. At **Deploy is live** it prints the dashboard address, `curl` commands to send a
   request and get its result, with the `<your api key>` placeholder where the key
   goes. [Endpoint](RUNTIME_CONTRACT.md#endpoint) covers the
   requests it takes.

| If                                                  | What happens                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| You run `canyonos deploy` again                     | It replaces this workflow group's previous deploy                                                                |
| The deploy fails before the workflow is up          | It removes what it started                                                                                   |
| You press Ctrl+C before the Global Controller is up | The same: it removes what it started                                                                         |
| You press Ctrl+C after that                         | It only stops watching. The deploy carries on; `canyonos logs` follows it again and `canyonos stop` stops it |

## Ports

| What      | Port   | When it's taken                                                  |
| --------- | ------ | ---------------------------------------------------------------- |
| Endpoint  | `8080` | The next free port                                               |
| Redis     | `6379` | The next free port, on `127.0.0.1` only                          |
| Dashboard | `8081` | The next free port                                               |
| Its API   | `3000` | The next free one; the CLI runs every workflow group through it  |
| Agents    | none   | The Global Controller reaches them over a private Docker network |

A port you set in `workflow_group.yaml` is never moved: if it's taken, the deploy stops,
or for `dashboard_port`, only the dashboard doesn't start. The deploy says when a port
moved, and a redeploy tries the last deploy's ports first.
[Ports a deploy opens](WORKFLOW_CONFIG.md#ports-a-deploy-opens) lists every port and the
setting that fixes it.

## Run several workflows

`canyonos deploy a b` runs both workflow folders in one workflow group, with one Global
Controller, Redis and endpoint, which serves each route at `POST /<workflow_id>`. Each
workflow group deploys on its own, so several can run at once and share one dashboard.
Their containers and images are named `canyonos-<folder>-<id>-...`, such as
`canyonos-a-1a2b3c4d-global-controller`, where `<folder>` is the folder that held the
`workflow_group.yaml` the workflow group started from, else its first workflow folder,
and `<id>` is the start of its `workflow_group_id`.

## Check it

```bash
canyonos status          # is it running, and the endpoint to send requests to
canyonos logs            # follow the Global Controller's logs
canyonos logs <agent>    # the last lines of one agent's replicas
canyonos doctor          # check the Global Controller, Redis, agents, endpoint and dashboard
```

The [dashboard](DASHBOARD.md) shows each request, its traces, logs, errors and cost.

## Change it

The deploy runs from a copy of the workflow, so an edit changes nothing until you apply
it: `canyonos sync .` from the workflow folder for files in the record's `config/`
(the folder's is no longer read), `canyonos deploy` for code and `.env`. See [Apply a change](CONFIGURE.md#apply-a-change).

## Stop

```bash
canyonos stop     # remove this workflow group's containers, keep its images for a quick redeploy
canyonos clean    # stop, then remove the agent images and the workflow group's record
```

With more than one workflow group, each lists them for you to pick, or takes a name:
`canyonos stop my-workflow-1a2b3c4d` works from any folder. The dashboard stops with the
last running workflow group and keeps its history. Neither command touches the `.env` in
a workflow folder.
[Stop and clean up](CLI.md#stop-and-clean-up) has what each command removes, and
`--all` for every workflow group on the machine.

If something goes wrong, see [Troubleshooting](TROUBLESHOOTING.md).
