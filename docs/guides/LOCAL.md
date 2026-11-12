# Local deployment

A local deploy runs the whole workflow as Docker containers on the machine that runs
`canyonos deploy`. It is the default, so a workflow config that sets neither `target`
nor `provider` deploys this way. This page covers what a deploy starts, the ports it
opens, and how to check, change and stop it.

You need CanyonOS [installed](../INSTALLATION.md) and Docker running; `canyonos doctor`
checks Docker.

## Where a workflow deploys

Two settings in the workflow config decide where a workflow runs:

- `target` picks what runs it: `docker`, CanyonOS on the machine that runs
  `canyonos deploy` (the default), or `kubernetes`, the CanyonOS operator on a cluster.
- `provider` picks where the agents run, and only applies to the `docker` target:
  `local` (the default), or EC2 with `ec2-pool` or `ec2-assign`.

| Deploy to                   | `target`     | `provider`                 | Set it with                       |
| --------------------------- | ------------ | -------------------------- | --------------------------------- |
| Locally, with Docker        | `docker`     | `local`                    | Nothing; it's the default         |
| [EC2](EC2.md)               | `docker`     | `ec2-pool` or `ec2-assign` | `provider` in the workflow config |
| [Kubernetes](KUBERNETES.md) | `kubernetes` | not used                   | `canyonos target kubernetes`      |

Check and switch the target from the workflow folder:

```bash
canyonos target              # show where this workflow deploys, and check you can reach it
canyonos target docker       # deploy with Docker (locally or EC2)
canyonos target kubernetes   # deploy to the cluster kubectl points at
```

`--target docker` or `--target kubernetes` on a single command, such as
`canyonos deploy --target docker`, overrides the target for that run only.

## Deploy

From the workflow folder (for a converted workflow, the folder that holds `.canyon`):

```bash
canyonos deploy
```

1. It checks the workflow: it warns about keys in `.env.example` that `.env` leaves
   missing or empty, and stops on any problem `canyonos validate` finds.
2. It shows each agent's CPU, memory, GPU and replicas. Choose **1. Deploy**, or
   **2. Configure an agent** to change them first.
3. It builds an image per agent and starts the Global Controller, Redis, the agents'
   replicas, the endpoint and, if it isn't running yet, the [dashboard](DASHBOARD.md).
4. At **Deploy is live** it prints the dashboard address and `curl` commands to send a
   request and get its result. [Endpoint](RUNTIME_CONTRACT.md#endpoint) covers the
   requests it takes.

| If                                                  | What happens                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| You run `canyonos deploy` again                     | It replaces this workflow's previous deploy                                                                  |
| The deploy fails before the workflow is up          | It removes what it started                                                                                   |
| You press Ctrl+C before the Global Controller is up | The same: it removes what it started                                                                         |
| You press Ctrl+C after that                         | It only stops watching. The deploy carries on; `canyonos logs` follows it again and `canyonos stop` stops it |

## Ports

| What      | Port   | When it's taken                                                  |
| --------- | ------ | ---------------------------------------------------------------- |
| Endpoint  | `8080` | The next free port                                               |
| Redis     | `6379` | The next free port, on `127.0.0.1` only                          |
| Dashboard | `8081` | The next free port                                               |
| Agents    | none   | The Global Controller reaches them over a private Docker network |

A port you set in the workflow config is never moved: if it's taken, the deploy stops,
or for `dashboard_port`, only the dashboard doesn't start. The deploy says when a port
moved, and a redeploy tries the last deploy's ports first.
[Ports a deploy opens](WORKFLOW_CONFIG.md#ports-a-deploy-opens) lists every port and the
setting that fixes it.

## Run several workflows

Each workflow folder deploys on its own, with its own containers, Redis and endpoint, so
several can run at once and share one dashboard. Their containers and images are named
`canyonos-<folder>-<id>-...`, such as `canyonos-my-workflow-1a2b3c4d-global-controller`,
where `<id>` is the start of the `project_id` the first deploy writes into the workflow
config.

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
it: `canyonos sync` for files in `config/`, `canyonos deploy` for code and `.env`. See
[Apply a change](CONFIGURE.md#apply-a-change).

## Stop

```bash
canyonos stop     # remove this workflow's containers, keep its images for a quick redeploy
canyonos clean    # stop, then remove .canyon, the installed skill and the agent images
```

With more than one workflow deployed, each lists them for you to pick, or takes a name:
`canyonos stop helloworld` works from any folder. The dashboard stops with the last
running workflow and keeps its history. Neither command touches `.env`.
[Stop and clean up](CLI.md#stop-and-clean-up) has what each command removes, and
`--all` for every workflow on the machine.

If something goes wrong, see [Troubleshooting](TROUBLESHOOTING.md).
