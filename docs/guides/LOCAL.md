# Local deployment

A local deploy runs the whole workflow as Docker containers on the machine that runs
`canyonos deploy`. It is the default, so a `deployment.yaml` that sets neither `target`
nor `provider` deploys this way. This page covers what a deploy starts, the ports it
opens, and how to check, change and stop it.

You need CanyonOS [installed](../INSTALLATION.md) and Docker running; `canyonos doctor`
checks Docker.

## Where a workflow deploys

Two settings in `deployment.yaml` decide where a workflow runs:

- `target` picks what runs it: `docker`, CanyonOS on the machine that runs
  `canyonos deploy` (the default), or `kubernetes`, the CanyonOS operator on a cluster.
- `provider` picks where the agents run, and only applies to the `docker` target:
  `local` (the default), or EC2 with `ec2-pool` or `ec2-assign`.

| Deploy to                   | `target`     | `provider`                 | Set it with                       |
| --------------------------- | ------------ | -------------------------- | --------------------------------- |
| Locally, with Docker        | `docker`     | `local`                    | Nothing; it's the default         |
| [EC2](EC2.md)               | `docker`     | `ec2-pool` or `ec2-assign` | `provider` in `deployment.yaml`   |
| [Kubernetes](KUBERNETES.md) | `kubernetes` | not used                   | `canyonos target kubernetes`      |

Kubernetes deploys don't support multi-folder deployments yet.

Check and switch the target from the deployment folder:

```bash
canyonos target              # show where this deployment runs, and check you can reach it
canyonos target docker       # deploy with Docker (locally or EC2)
canyonos target kubernetes   # deploy to the cluster kubectl points at
```

`--target docker` or `--target kubernetes` on a single command, such as
`canyonos deploy ../my-project --target docker`, overrides the target for that run only.

## Deploy

From the folder above the project folder (for a converted workflow, the project folder
holds `.canyon`), with a deployment folder of its own beside it:

```bash
canyonos deploy my-project --folder my-deployment
```

It makes the deployment folder and its `deployment.yaml` when there are none. Run the
other commands, a redeploy included, from the deployment folder:
`cd my-deployment && canyonos deploy ../my-project`.

It needs a key, made once per machine with `canyonos keys create`; without one it stops
before it builds anything and prints that command. See
[Tokens and keys](AUTHORIZATION.md).

1. It checks each project: it warns about keys in `.env.example` that `.env` leaves
   missing or empty, and stops on any problem `canyonos validate` finds.
2. It shows each agent's CPU, memory, GPU and replicas. Choose **1. Deploy**, or
   **2. Configure an agent** to change them first.
3. It builds an image per agent and starts the Global Controller, Redis, the agents'
   replicas, the endpoint and, if it isn't running yet, the [dashboard](DASHBOARD.md).
4. At **Deploy is live** it prints the dashboard address, `curl` commands to send a
   request and get its result, and the `canyonos token create` command that makes the
   token they send. [Endpoint](RUNTIME_CONTRACT.md#endpoint) covers the
   requests it takes.

| If                                                  | What happens                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| You run `canyonos deploy` again                     | It replaces this deployment's previous deploy                                                                |
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

A port you set in `deployment.yaml` is never moved: if it's taken, the deploy stops,
or for `dashboard_port`, only the dashboard doesn't start. The deploy says when a port
moved, and a redeploy tries the last deploy's ports first.
[Ports a deploy opens](WORKFLOW_CONFIG.md#ports-a-deploy-opens) lists every port and the
setting that fixes it.

## Run several workflows

`canyonos deploy ../a ../b` runs both project folders in one deployment, with one
Global Controller, Redis and endpoint, which serves each route at
`POST /<project>/<agent>/<method>`. Each deployment folder deploys on its own, so
several can run at once and share one dashboard. Their containers and images are named
`canyonos-<folder>-<id>-...`, such as `canyonos-my-deployment-1a2b3c4d-global-controller`,
where `<folder>` is the deployment folder and `<id>` is the start of the `deployment_id`
the first deploy writes into `deployment.yaml`.

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
it: `canyonos sync ../my-project` for files in `config/`, `canyonos deploy` for code
and `.env`. See [Apply a change](CONFIGURE.md#apply-a-change).

## Stop

```bash
canyonos stop     # remove this deployment's containers, keep its images for a quick redeploy
canyonos clean    # stop, then remove the agent images; each project's .canyon stays
```

With more than one deployment, each lists them for you to pick, or takes a name:
`canyonos stop my-deployment` works from any folder. The dashboard stops with the last
running deployment and keeps its history. Neither command touches `.env`.
[Stop and clean up](CLI.md#stop-and-clean-up) has what each command removes, and
`--all` for every deployment on the machine.

If something goes wrong, see [Troubleshooting](TROUBLESHOOTING.md).
