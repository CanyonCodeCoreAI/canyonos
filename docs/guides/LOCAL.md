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

1. The deploy shows each agent's CPU, memory, GPU and replicas. Choose **1. Deploy**, or
   **2. Configure an agent** to change them first.
2. Wait for **Deploy is live**. It prints the dashboard address and `curl` commands to
   send a request and get its result.

Before it builds anything, the deploy warns about keys in `.env.example` that are
missing or empty in `.env`, and stops on any problem `canyonos validate` finds. Then it
builds an image per agent and starts the Global Controller, Redis, a container per
replica and the endpoint. It also starts the [dashboard](DASHBOARD.md) if it isn't
running yet.

Run `canyonos deploy` again at any time: it replaces this workflow's previous deploy.
If a deploy fails before the workflow is up, it removes what it started. Ctrl+C while
it pulls or starts the Global Controller does the same. Once it is building images or
starting agents, Ctrl+C only stops watching: the deploy carries on, and `canyonos logs`
follows it.

The endpoint's requests and responses are described in
[Runtime contract](RUNTIME_CONTRACT.md#endpoint).

## Ports

The endpoint opens on `8080`, Redis on `6379` and the dashboard on `8081`. When one of
those is taken and you didn't set it in the workflow config, the deploy uses the next
free port. It warns when the endpoint or Redis moves, and its summary shows the
dashboard's address. A redeploy keeps the ports the last deploy got.

Agents publish no ports: the Global Controller reaches them over a private Docker
network. [Ports a deploy opens](WORKFLOW_CONFIG.md#ports-a-deploy-opens) lists every
port, the setting that fixes it, and what happens when a port you set is taken.

## Run several workflows

Each workflow folder deploys on its own, with its own containers, Redis and endpoint, so
several can run at once. They share one dashboard.

Containers and images are named `canyonos-<project>-...`, where `<project>` is the
folder name and the first 8 characters of the workflow's `project_id`, for example
`canyonos-my-workflow-1a2b3c4d-global-controller`. The first deploy writes
`project_id` into the workflow config.

## Check it

```bash
canyonos status          # is it running, and the endpoint to send requests to
canyonos logs            # follow the Global Controller's logs
canyonos logs <agent>    # the last lines of one agent's replicas
canyonos doctor          # check the Global Controller, Redis, agents, endpoint and dashboard
```

The [dashboard](DASHBOARD.md) shows each request, its traces, logs, errors and cost.

## Change it

The Global Controller works on a copy of the workflow, so editing a file changes
nothing until you apply it. `canyonos sync` applies changes in `config/` to the running
deploy; code and `.env` changes need `canyonos deploy`. See
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
