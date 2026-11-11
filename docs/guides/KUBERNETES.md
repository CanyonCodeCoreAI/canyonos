# Kubernetes deployment

This guide runs a workflow on a Kubernetes cluster, either a local one to try it or your
own. It is for the cluster admin who installs CanyonOS once, and for developers who
deploy workflows there.

The CanyonOS operator, installed once per cluster, runs each workflow's Redis, Global
Controller, endpoint and agents in the workflow's namespace. `canyonos deploy` uploads
the workflow, and the cluster builds the agents' images, pushes them to your registry
and starts them. Nothing else on the cluster changes. How the operator works is in
[Operator](../architecture/OPERATOR.md).

## What you need

- The CanyonOS CLI, [installed](../INSTALLATION.md), and
  [`kubectl`](https://kubernetes.io/docs/tasks/tools/).
- A cluster with the CanyonOS operator of the CLI's release on it. To try CanyonOS on
  your own machine, `canyonos cluster up` makes one.
- A container registry that the cluster's builder can push to and its nodes can pull
  from. A local cluster comes with one on `localhost:5001`.

Each person needs this access to the cluster:

| Who                   | Needs                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Installs the operator | Cluster admin: the chart installs CRDs, cluster roles and namespaces                                                                             |
| Deploys a workflow    | The edit role in the workflow's namespace. For `canyonos deploy` to create the namespace, also permission to create namespaces; else ask for one |
| Opens the dashboard   | Permission to port-forward into the `canyonos-dashboard` namespace                                                                               |

## Set up the cluster

<div class="tabs" markdown>

<div class="tab" data-label="Local cluster" markdown>

`canyonos cluster up` makes a Kubernetes cluster on this machine, with CanyonOS on it.
It needs Docker with 4 CPUs and 8 GB of memory or more,
[`kind`](https://kind.sigs.k8s.io/docs/user/quick-start/#installation) and `kubectl`:

```bash
brew install kind kubectl                            # macOS
winget install Kubernetes.kind Kubernetes.kubectl    # Windows
```

Then make the cluster:

```bash
canyonos cluster up    # about 10 minutes the first time
```

It makes:

1. A registry on `localhost:5001`.
2. A kind cluster named `canyonos`, with one control plane and one worker
   (`--workers 3` for more, when the cluster is made). It has Calico, so NetworkPolicy
   is enforced, metrics-server, and Pod Security `restricted` in every namespace.
3. CanyonOS of the CLI's release, with the builder and the dashboard.

`kubectl` then points at the new cluster. After you upgrade the CLI, run
`canyonos cluster up` again to bring the cluster to the same release.

To develop CanyonOS itself on a local cluster, see
[Kubernetes on kind](../contributing/DEVELOPMENT.md#kubernetes-on-kind).

</div>

<div class="tab" data-label="Existing cluster" markdown>

A cluster admin installs the operator once, with Helm, from the chart each release
publishes:

```bash
helm install canyonos oci://ghcr.io/canyoncodecoreai/charts/canyonos-operator \
  --version <version> --namespace canyonos-system --create-namespace \
  --set builder.enabled=true
```

`<version>` is the CLI's, as `canyonos --version` prints it.

Add `--set dashboard.enabled=true` for the [dashboard](#dashboard), and any of the
[operator settings](#operator-settings) below.

</div>

</div>

The CLI and the operator must be the same release, because every CanyonOS image the
cluster runs comes from the operator's release. A deploy from a CLI of another release
stops before it uploads anything, and says whether to upgrade the operator or use the
matching CLI. See [Upgrading the operator](#upgrading-the-operator).

### Operator settings

Set these with `--set` on `helm install`:

| Setting                            | Default                        | What it does                                                                                                                                                                             |
| ---------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `builder.enabled`                  | `false`                        | Installs the in-cluster image builder (rootless BuildKit in `canyonos-build`). Every deploy builds with it, so turn it on.                                                               |
| `builder.registryAliases`          | `{}`                           | A registry the builder reaches by another name than the nodes pull it by. kind: `{"localhost:5001": "kind-registry:5000"}`.                                                              |
| `builder.insecureRegistries`       | `[]`                           | Registries the builder may push to over plain HTTP. Use it for a local kind registry only.                                                                                               |
| `dashboard.enabled`                | `false`                        | Installs one dashboard for every workflow on the cluster. See [Dashboard](#dashboard).                                                                                                   |
| `watchNamespaces`                  | `[]`                           | Empty: workflows may run in any namespace, and the operator has cluster-wide permissions. A list: only those namespaces, with the operator's permissions granted in them alone.          |
| `userRoles.enabled`                | `true`                         | Whoever may administer, edit or view a namespace may do the same with its CanyonProjects, CanyonAgents and CanyonBuilds. This is what makes a namespace's edit role enough to deploy.    |
| `imageRegistry`                    | `ghcr.io/canyoncodecoreai`     | Where CanyonOS's own images come from. Each image setting left empty is `<imageRegistry>/canyonos-<name>:<version>`. Point it at a registry mirror that holds them under the same names. |
| `controllerImage`                  | this release's `canyonos-core` | The image that every workflow's Global Controller and endpoint, and the in-cluster build, run.                                                                                           |
| `image.repository`, `image.digest` | this release's operator        | The operator's own image. Prefer a digest.                                                                                                                                               |
| `redisImage`                       | the operator's default         | The image of each workflow's Redis, for a mirror.                                                                                                                                        |
| `metrics.enabled`                  | `true`                         | Serves the operator's Prometheus metrics on `8443` over HTTPS. Callers need the `canyonos-metrics-reader` role.                                                                          |

The dashboard's own settings are under [Dashboard](#dashboard-settings).

### Permissions and Pod Security

What CanyonOS asks of your cluster:

- The operator reads only the Secrets it needs, the Redis passwords, by name. It never
  lists Secrets.
- It never changes an object it did not create.
- Every pod it creates meets the `restricted` Pod Security profile. Agents get no
  Kubernetes API token.
- The builder's namespace, `canyonos-build`, is the one exception: it is `privileged`,
  because BuildKit's user namespaces need seccomp and AppArmor unconfined. Nothing else
  runs there, and only build pods may reach it.

## Point a workflow at the cluster

```bash
canyonos target kubernetes    # in the workflow folder, with kubectl pointing at the cluster
```

It writes `target: kubernetes` at the top of the workflow config and a `kubernetes:`
block under it, then checks that `kubectl` is installed, the cluster answers and the
operator is installed. The block gets:

| Key         | Set to                                                                                                                           | To choose another |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `namespace` | The folder's name, lowercased, with anything but letters, digits and hyphens turned into hyphens                                 | `--namespace`     |
| `registry`  | The one the cluster advertises in the standard `local-registry-hosting` ConfigMap, as `canyonos cluster up`'s does; else it asks | `--registry`      |

Values already in the block are kept unless one of those options replaces them.
`canyonos target` alone shows where the workflow deploys and runs the same checks, and
`canyonos target docker` switches back to Docker, keeping the block. The
[CLI reference](CLI.md#where-it-runs) lists the options.

## Deploy and run

```bash
canyonos deploy      # build in the cluster, start, wait until ready
canyonos status      # the workflow and each agent's replicas (--json for scripts)
canyonos test "hi"   # send one query to the deployed workflow and show the result
canyonos logs        # the Global Controller's logs (or: HelloAgent, HelloAgent-0)
canyonos doctor      # check the cluster, the operator and the deployed workflow
```

`canyonos deploy` prints the endpoint's URL and the `curl` commands to call it. Every
command uses the workflow's `target`; `--target` overrides it for one run (see the
[CLI reference](CLI.md#where-it-runs)).

### What a deploy does

The CLI needs no Docker for this. `canyonos deploy`:

1. Creates the namespace if it's missing, labeled as made by CanyonOS.
2. Turns `.env` into a Secret in the namespace, unless `env_secret` names your own.
3. Asks the operator for a build (a CanyonBuild) and uploads the workflow root to the
   build's pod through a port-forward. `.env` and every other `.env*` file, `.git`,
   `.venv`, `node_modules` and `__pycache__` are never uploaded.
4. The build builds each agent's image on the cluster's builder, pushes it by digest,
   and applies the workflow's objects from the workflow config. A redeploy of unchanged
   code restarts nothing.
5. Waits until the operator reports the workflow and every agent ready, then forwards
   the endpoint to this machine and opens the dashboard.

The first deploy writes a `project_id` into the workflow config; commit it, so telemetry
stays under one project across deploys and targets. The workflow's CanyonProject is
named after its folder and the start of that ID (`helloworld-4eeed6f3`), so two folders
of the same name never share one in a namespace.

### Reach the endpoint

| In the `kubernetes:` block | Where the endpoint is                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Neither setting below      | Inside the cluster only, at `http://canyonos-endpoint.<namespace>.svc:8080`. `canyonos deploy` forwards it to `http://127.0.0.1:8080` on this machine |
| `endpoint.host`            | An Ingress at that host; the deploy prints its address                                                                                                |
| `endpoint.url`             | That URL, which you expose yourself; the deploy prints it                                                                                             |

The forward takes `8080`, or the next free port by the same rule as on Docker (see
[Ports a deploy opens](WORKFLOW_CONFIG.md#ports-a-deploy-opens)). An
`endpoint.api_port` you set is never moved: if it's taken, the endpoint isn't forwarded
and the deploy warns. A background `canyonos` process holds the forward open, starts it
again when the endpoint's pod is replaced, as on a redeploy, and runs until
`canyonos stop`.

### Differences from Docker

The commands take the same options as on Docker, with these differences:

- `test` never deploys. It queries the workflow as deployed, once it's ready, through a
  port-forward it opens and closes itself.
- `logs <agent>` keeps following until Ctrl-C, as `logs` does. `--no-follow` prints
  and exits.
- `deploy -v` has no effect.
- `canyonos sync`, and changes saved in `canyonos config`, don't reach the cluster. Run
  `canyonos deploy` again after any change.

## Configuration

`canyonos target kubernetes` writes the two required settings. Written by hand, the
block is:

```yaml
target: kubernetes
kubernetes:
  namespace: acme                       # created on deploy if missing and you may create it
  registry: registry.example.com/acme   # where images are pushed, and nodes pull from
```

`${VAR}` in the block is filled in from the workflow's `.env`, which also holds the only
values the build in the cluster sees.

Optional settings:

| Setting                  | Default                 | What it does                                                                                                                                                                                                                                         |
| ------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform`               | the nodes' own          | `linux/amd64` or `linux/arm64`. Left out, the build targets the architecture of the node it runs on, so an ARM cluster (Graviton, kind on Apple silicon) gets ARM images. On a mixed cluster, set it and a `node_selector` for `kubernetes.io/arch`. |
| `image_pull_secret`      | none                    | A `docker-registry` Secret in the namespace, for a private registry. The build pushes with it, and every pod pulls with it.                                                                                                                          |
| `service_account`        | the namespace's default | The ServiceAccount agents run as, for IRSA or workload identity. Agents get no Kubernetes API token either way.                                                                                                                                      |
| `env_secret`             | made from `.env`        | An existing Secret to give every pod as its environment, instead of the one `canyonos deploy` makes from `.env`.                                                                                                                                     |
| `node_selector`          | none                    | The node labels the workflow's pods must match.                                                                                                                                                                                                      |
| `redis.storage`          | `1Gi`                   | The disk of the Redis the operator runs.                                                                                                                                                                                                             |
| `redis.storage_class`    | the cluster's default   | The storage class of that disk.                                                                                                                                                                                                                      |
| `redis.host`             | none                    | Your own Redis (for example, ElastiCache) instead of one the operator runs. `redis.storage` and `redis.storage_class` then don't apply.                                                                                                              |
| `redis.port`             | `6379`                  | The port of your own Redis. Needs `redis.host`.                                                                                                                                                                                                      |
| `redis.tls`              | `false`                 | Connect to your own Redis over TLS. Needs `redis.host`.                                                                                                                                                                                              |
| `redis.password_secret`  | none                    | A Secret with `password`, and optionally `username`, for your own Redis. Needs `redis.host`.                                                                                                                                                         |
| `endpoint.host`          | none                    | Expose the endpoint through an Ingress at this host, served by the cluster's default ingress class. On OpenShift, the router serves the Ingress as a Route.                                                                                          |
| `endpoint.ingress_class` | the cluster's default   | The ingress class of that Ingress. Needs `endpoint.host`.                                                                                                                                                                                            |
| `endpoint.tls_secret`    | none                    | A Secret with the host's certificate. The endpoint is then served over HTTPS. Needs `endpoint.host`.                                                                                                                                                 |
| `endpoint.url`           | none                    | The URL callers use when you expose the endpoint yourself (Gateway API, a service mesh, a Route made by hand). CanyonOS creates nothing for it.                                                                                                      |
| `databases`              | none                    | Settings for each `type: database` agent. See [Databases](#databases).                                                                                                                                                                               |

Each agent's `resources` become its pods' limits: `cpu` cores, `memory` in MB, and `gpu`
as `nvidia.com/gpu`. Each pod requests 100m of CPU and all of its memory.

On Kubernetes, `provider` and the `ec2-pool:` and `ec2-assign:` sections have no effect.
An `otel` destination on the local dashboard or on `host.docker.internal` is skipped,
with a warning. Every other
key is described in [Workflow config](WORKFLOW_CONFIG.md).

### Databases

A `type: database` agent runs its stock image as one replica on its own disk, mounted at
its `volume_path`; on Kubernetes, `volume_path` is required. The disk survives a
redeploy, the agent's removal and `canyonos clean`, as a Docker volume does. Other
agents reach the database through routing, as on Docker.

The `restricted` profile requires a non-root user, so give the user IDs the image
expects, and the disk's size, under `kubernetes.databases`:

```yaml
kubernetes:
  databases:
    StateDB: {run_as_user: 70, fs_group: 70, storage: 5Gi}   # postgres:16-alpine
```

| Setting         | Default               | What it does                         |
| --------------- | --------------------- | ------------------------------------ |
| `run_as_user`   | the image's own       | The user ID the database runs as     |
| `fs_group`      | none                  | The group that owns the disk's files |
| `storage`       | `1Gi`                 | The size of the disk                 |
| `storage_class` | the cluster's default | The storage class of the disk        |

## Scaling

The Global Controller scales each agent through its CanyonAgent's `/scale`, the same way
an HPA would, within the bounds of `scaling.yaml` (see [Autoscaling](SCALING.md)). A
redeploy keeps the live count of autoscaled agents.

Don't add a HorizontalPodAutoscaler or a KEDA ScaledObject for a CanyonAgent: two
scalers undo each other's counts. The operator reports one as the agent's
`ScalingConflict` condition, and `canyonos status` and `canyonos deploy` show it. The
operator never changes your HPA.

Starting points for alerts:

- An agent's CPU above 70% of its limit for five minutes.
- The endpoint, which always runs one replica, above one core.
- p95 time to a result above 2 s.
- A CanyonAgent with `Ready=False` and reason `Unschedulable`.

## Dashboard

One dashboard serves every workflow on the cluster. Install it with the operator by
adding `--set dashboard.enabled=true`; `canyonos cluster up` installs it for you. It
runs in the `canyonos-dashboard` namespace: the API, the web front end, and Postgres on
a 1Gi disk, all under the `restricted` Pod Security profile.

```bash
canyonos serve    # http://127.0.0.1:8081, until canyonos stop
```

- **Opening it:** `canyonos deploy` opens it unless you pass `--serve false`, and says
  so and carries on when the cluster has none; `canyonos serve` opens it on its own. It
  is a port-forward held open in the background, like the endpoint's, on `8081` or the
  next free port; a `dashboard_port` you set is never moved. `canyonos stop` closes it
  with the last workflow forwarded from this machine.
- **Who can open it:** only someone allowed to port-forward into `canyonos-dashboard`;
  nothing is exposed outside the cluster. Unlike the local dashboard, it always asks you
  to sign in (`AUTH_MODE=password`), because every workflow's Global Controller may
  reach its API. The first account made is its only one: registration closes after it.
- **How it reaches workflows:** the operator lists every workflow whose Redis is ready,
  with how to reach it, in the Secret `canyonos-dashboard-projects`, so the dashboard
  needs no access to any workflow's Secrets. Each workflow's Redis admits the
  dashboard's API pod and nothing else from that namespace, and each Global Controller
  sends its telemetry to the dashboard.

### Dashboard settings

| Setting                                | Default                                          | What it does                                                                                                                                                                                                                                                                                                |
| -------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dashboard.apiImage`, `webImage`       | this release's `canyonos-api` and `canyonos-web` | The dashboard's images, for a mirror.                                                                                                                                                                                                                                                                       |
| `dashboard.dbImage`                    | `postgres:16-alpine`                             | The database's image.                                                                                                                                                                                                                                                                                       |
| `dashboard.storage`                    | `1Gi`                                            | The database's disk.                                                                                                                                                                                                                                                                                        |
| `dashboard.storageClassName`           | the cluster's default                            | The storage class of that disk.                                                                                                                                                                                                                                                                             |
| `dashboard.existingSecret`             | none                                             | Your own Secret with `db-password`, plus a `jwt-secret` and a `redis-password-key` of 32 characters or more each. Without it, the chart makes all three on install and keeps them. Set it when the chart is rendered without the cluster (`helm template`, Argo CD), which can't keep a generated password. |
| `dashboard.fixedUsers`                 | `true`                                           | Runs the images as their own users. Set it to `false` on OpenShift, which assigns user IDs itself.                                                                                                                                                                                                          |
| `dashboard.metricsRawRetentionDays`    | `3`                                              | Days to keep raw five-second metric ticks, which ranges of 30 minutes or less read.                                                                                                                                                                                                                         |
| `dashboard.metricsRollupRetentionDays` | `120`                                            | Days to keep five-minute rollups, which longer ranges read.                                                                                                                                                                                                                                                 |

## Stop and clean up

| Command                 | What it removes                                                                                                                                                                                                       | What stays                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `canyonos stop`         | The workflow's CanyonProject, and with it the endpoint, agents, Global Controller and Redis with its disk. The endpoint's port-forward on this machine, and the dashboard's when no other workflow here is forwarded. | The namespace, the ConfigMap of the workflow config, the `.env` Secret, and each database's disk |
| `canyonos clean`        | What `stop` removes, then the ConfigMap and the `.env` Secret                                                                                                                                                         | The namespace, each database's disk, and everything on this machine but the port-forwards        |
| `canyonos cluster down` | The local kind cluster, and the port-forwards to it                                                                                                                                                                   | The registry and the images in it, unless you pass `--all`                                       |

- **Order:** `stop` takes the endpoint down first, so no new request arrives, then each
  agent, taken out of routing before its pods stop, and Redis and the Global Controller
  last; see [Operator](../architecture/OPERATOR.md#dashboard-deletion-and-install). It
  closes the port-forwards even when the cluster can't be reached. A workflow on your
  own Redis leaves none of CanyonOS's keys in it.
- **The namespace:** `clean` never deletes it, since it may hold more than the
  workflow. When `canyonos deploy` created it, `clean` prints the command to delete it.
- **Database disks:** each is the PersistentVolumeClaim `data-<agent>-0`; delete it with
  `kubectl` once you don't need the data.
- **`--all`:** `stop --all` and `clean --all` act on this machine's Docker only, so run
  `stop` or `clean` in each workflow's folder.

## Upgrading the operator

Helm installs the CRDs once and never upgrades them, so apply a release's new CRDs
yourself before you `helm upgrade` to it, or its new fields are dropped.
`--force-conflicts` takes them over from Helm:

```bash
helm show crds oci://ghcr.io/canyoncodecoreai/charts/canyonos-operator --version <version> \
  | kubectl apply --server-side --force-conflicts -f -
helm upgrade canyonos oci://ghcr.io/canyoncodecoreai/charts/canyonos-operator \
  --version <version> --namespace canyonos-system --reuse-values
```

`--reuse-values` keeps every setting from the install. An image left to the chart
follows the new release; one you set by hand (`image.digest`, `controllerImage`, the
dashboard's) stays as it was, so pass its new value with `--set`.

Never delete a CRD: Kubernetes then deletes every resource of that kind in the cluster.
Deleting the CanyonProject CRD takes down every workflow on it.

## Rotating the Redis password

The operator makes each workflow's Redis password once, in the Secret `canyonos-redis`.
Deleting the Secret rotates the password:

```bash
kubectl -n <namespace> delete secret canyonos-redis
```

The operator makes a new password, restarts Redis with it, then restarts the Global
Controller, the endpoint and the agents, one pod at a time, so they sign in with it.
Until a pod restarts it can't reach Redis, so requests fail for the minute or two this
takes.

## Known limits

- A replica that stops, on a scale-down, an update or `canyonos stop`, leaves routing,
  then finishes the calls it holds. It has 180 seconds from when it starts stopping; a
  call still running after that fails.
- The dashboard's namespace holds every workflow's Redis password, in
  `canyonos-dashboard-projects`. Let only cluster admins read Secrets there.
- The builder admits any pod labeled as a CanyonOS build, and the dashboard's API takes
  telemetry from any pod labeled as a workflow's Global Controller. Labels are not proof
  of identity.
- The CLI can't write a workflow's Kubernetes objects to a file for GitOps: the
  in-cluster build applies them.

## Troubleshooting

Start with `canyonos doctor`. It checks `kubectl`, the cluster, the operator and its
release, then the deployed workflow, its agents, endpoint and dashboard, and gives a fix
for each failure.

| Problem                                                  | What to do                                                                                                                                                                                                                                    |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "The CanyonOS operator is not installed on this cluster" | [Set up the cluster](#set-up-the-cluster), or point `kubectl` at the right one: `kubectl config use-context <name>`.                                                                                                                          |
| "they must be the same release"                          | [Upgrade the operator](#upgrading-the-operator) to the CLI's release, or deploy with the CLI of the operator's release.                                                                                                                       |
| The namespace "does not exist and could not be created"  | Ask a cluster admin for the namespace, or set one you have with `canyonos target kubernetes --namespace <name>`.                                                                                                                              |
| "The image build failed"                                 | The error names the build's log: `kubectl -n <namespace> logs job/<build> -c build`. A failed CanyonBuild is kept so you can look at it.                                                                                                      |
| The deploy waits with "no node to run on"                | The message gives the scheduler's reason: too little CPU or memory (see [Configuration](#configuration) for what each pod requests), a taint, or a `node_selector` that no node matches. On a local cluster, give Docker more CPU and memory. |
| An agent fails the deploy at once                        | The operator can never start it as configured. The error gives the operator's reason.                                                                                                                                                         |
| "Not ready after 10 minutes"                             | Look at `kubectl -n <namespace> get pods` and `kubectl -n <namespace> describe canyonagents`.                                                                                                                                                 |
| "The endpoint is not forwarded to this machine"          | The warning gives the reason. Most often the `endpoint.api_port` you set is taken: free it, or remove the setting to take the next free port.                                                                                                 |
| The operator itself misbehaves                           | Read its logs: `kubectl -n canyonos-system logs deploy/canyonos-controller-manager`.                                                                                                                                                          |
