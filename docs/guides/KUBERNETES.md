# Kubernetes workflow group

This guide runs a workflow on a Kubernetes cluster, either a local one to try it or your
own. It is for the cluster admin who installs CanyonOS once, and for developers who
deploy workflows there.

The CanyonOS operator, installed once per cluster, runs each workflow's Redis, Global
Controller, endpoint and agents in the workflow's namespace. Its chart also installs the
CanyonOS API, which `canyonos deploy` uploads the workflow to; the cluster then builds
the agents' images, pushes them to your registry and starts them. Nothing else on the
cluster changes. How the operator works is in [Operator](../architecture/OPERATOR.md).

A workflow group is laid out as for a [Docker deploy](LOCAL.md): `canyonos deploy` takes
the workflow folders to deploy, and keeps the workflow group's `workflow_group.yaml` in
its record, `~/.canyonos/workflows/<workflow group>/`. The whole workflow group is one
CanyonProject. With `deploy_mode: toy`, each workflow's agents build into one image and
run as one CanyonAgent.

## What you need

- The CanyonOS CLI, [installed](../INSTALLATION.md), and
  [`kubectl`](https://kubernetes.io/docs/tasks/tools/).
- A cluster with the CanyonOS operator of the CLI's release on it. To try CanyonOS on
  your own machine, `canyonos cluster up` makes one. On your own cluster, the admin
  installs the operator with [Helm](https://helm.sh/docs/intro/install/) 3.
- A container registry that the cluster's builder can push to and its nodes can pull
  from. A local cluster comes with one on `localhost:5001`.

Each person needs this access to the cluster:

| Who                   | Needs                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Installs the operator | Cluster admin: the chart installs CRDs, cluster roles and namespaces                                                                             |
| Deploys a workflow    | The edit role in the workflow's namespace. For `canyonos deploy` to create the namespace, also permission to create namespaces; else ask for one |
| Opens the dashboard   | Permission to port-forward to `svc/canyonos-dashboard-web` in the `canyonos-dashboard` namespace, and the dashboard's API key                    |

Every signed-in user may port-forward to the CanyonOS API, as `canyonos deploy` does; the
API then checks with Kubernetes what each one may do. See
[Permissions and Pod Security](#permissions-and-pod-security).

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
3. CanyonOS of the CLI's release, with the builder and the dashboard. The dashboard
   takes this machine's API key, `~/.canyonos/api_key`, made there if there is none.

`kubectl` then points at the new cluster. After you upgrade the CLI, run
`canyonos cluster up` again to bring the cluster to the same release.

To develop CanyonOS itself on a local cluster, see
[Kubernetes on kind](../contributing/DEVELOPMENT.md#kubernetes-on-kind).

</div>

<div class="tab" data-label="Existing cluster" markdown>

A cluster admin installs the operator once, with Helm, from the chart each release
publishes:

```bash
KEY="<the dashboard's API key, which you pick>"
helm install canyonos oci://ghcr.io/canyoncodecoreai/charts/canyonos-operator \
  --version <version> --namespace canyonos-system --create-namespace \
  --set dashboard.apiKeyHash="$(printf %s "$KEY" | sha256sum | cut -d' ' -f1)"
```

`<version>` is the CLI's, as `canyonos --version` prints it.

The chart always installs the [CanyonOS API](#the-canyonos-api) too, with its Postgres
on a 1Gi PersistentVolumeClaim, so the cluster needs a default StorageClass, or set
`dashboard.storageClassName`. It refuses to install without `dashboard.apiKeyHash`, the
sha256 of the key the API's dashboard routes take, or `dashboard.existingSecret`. The
in-cluster image builder and the [dashboard](#dashboard)'s web front end come with it.
Add any of the [operator settings](#operator-settings) below.

Where your cluster's policy forbids privileged namespaces or pods (Pod Security enforced
cluster-wide, a Kyverno or Gatekeeper rule, OpenShift's default security policies), this
install fails, or the builder never starts: install with `--set builder.enabled=false`.
Deploys then can't build images in the cluster. See
[Permissions and Pod Security](#permissions-and-pod-security).

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
| `builder.enabled`                  | `true`                         | Installs the in-cluster image builder (rootless BuildKit in `canyonos-build`). Every deploy builds with it. Turn it off only where policy forbids its privileged namespace.              |
| `builder.registryAliases`          | `{}`                           | A registry the builder reaches by another name than the nodes pull it by. kind: `{"localhost:5001": "kind-registry:5000"}`.                                                              |
| `builder.insecureRegistries`       | `[]`                           | Registries the builder may push to over plain HTTP. Use it for a local kind registry only.                                                                                               |
| `dashboard.enabled`                | `true`                         | The dashboard's web front end, for every workflow on the cluster. The CanyonOS API is installed either way. See [Dashboard](#dashboard).                                                 |
| `watchNamespaces`                  | `[]`                           | Empty: workflows may run in any namespace, and the operator has cluster-wide permissions. A list: only those namespaces, with the operator's permissions granted in them alone.          |
| `userRoles.enabled`                | `true`                         | Whoever may administer, edit or view a namespace may do the same with its CanyonProjects, CanyonAgents and CanyonBuilds. This is what makes a namespace's edit role enough to deploy.    |
| `imageRegistry`                    | `ghcr.io/canyoncodecoreai`     | Where CanyonOS's own images come from. Each image setting left empty is `<imageRegistry>/canyonos-<name>:<version>`. Point it at a registry mirror that holds them under the same names. |
| `controllerImage`                  | this release's `canyonos-core` | The image that every workflow's Global Controller and endpoint, the in-cluster build, and the CanyonOS API's `core` container run.                                                       |
| `image.repository`, `image.digest` | this release's operator        | The operator's own image. Prefer a digest.                                                                                                                                               |
| `redisImage`                       | the operator's default         | The image of each workflow's Redis, for a mirror.                                                                                                                                        |
| `metrics.enabled`                  | `true`                         | Serves the operator's Prometheus metrics on `8443` over HTTPS. Callers need the `canyonos-metrics-reader` role.                                                                          |

The CanyonOS API's and the dashboard's own settings, `dashboard.apiKeyHash` among them,
are under [Dashboard settings](#dashboard-settings).

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
- The CanyonOS API acts for each caller only as far as Kubernetes lets that caller: it
  checks the caller's kubectl token (a TokenReview), then asks whether they may `get`
  (to read) or `update` (to change) CanyonProjects in the workflow's namespace (a
  SubjectAccessReview). Its own ServiceAccount, `canyonos-api` in `canyonos-dashboard`,
  has the ClusterRole `canyonos-api`: it may create and patch Secrets (each workflow's
  `.env`), delete labeled Secrets and ConfigMaps, read pods and their logs, manage
  CanyonBuilds, and list, patch and delete CanyonProjects and list CanyonAgents. The
  build pod, not the API, applies the CanyonProject and its CanyonAgents.
- That ClusterRole is cluster-wide even with `watchNamespaces`: the API finds every
  workflow's CanyonProject after a restart, and deploys into any namespace its caller
  may change.
- Every signed-in user may port-forward into `canyonos-dashboard` (the Role
  `canyonos-dashboard-api-forward`, bound to `system:authenticated`), because the CLI
  reaches the API that way. A port-forward can't be limited to one pod, so it reaches
  the web front end and Postgres too: Postgres still needs its password, and the API's
  dashboard routes the API key, which is why the chart requires one.
- The API's pod gets its Kubernetes token in its `api` container only, not in `core`.

## Point a workflow at the cluster

Put `target: kubernetes` at the top of the workflow group's `workflow_group.yaml`, in
its record, and a `kubernetes:` block under it, as [Configuration](#configuration)
shows. Before the first deploy, put them in a `workflow_group.yaml` in the folder you
deploy from: the first deploy copies it into the record.

## Deploy and run

```bash
canyonos deploy .    # build in the cluster, start, wait until ready
canyonos status      # the workflow and each agent's replicas (--json for scripts)
canyonos test "hi"   # send one query to the deployed workflow and show the result
canyonos logs        # the Global Controller's logs (or: HelloAgent, HelloAgent-0)
canyonos doctor      # check the cluster, the operator and the deployed workflow
```

`canyonos deploy --api-key <key>` sets this machine's API key, as on Docker (see
[API key](AUTHORIZATION.md)); later deploys reuse it. Without a key, the endpoint
answers anyone who reaches it. The deploy prints the endpoint's URL and the `curl`
commands to call it. Every command uses the workflow's `target`.

**Estimated time:** on a cluster that already runs CanyonOS, pointing a workflow at it
is two keys in `workflow_group.yaml` and the deploy is one command; the cluster then
builds each agent's image. A local cluster from `canyonos cluster up` takes about 10
minutes the first time.

### What a deploy does

The CLI needs no Docker for this. `canyonos deploy` uploads `workflow_group.yaml`, its
`.env` and each workflow folder to the [CanyonOS API](#the-canyonos-api), through a
port-forward, signed in with your kubectl login. `.git`, `.venv`, `node_modules` and
`__pycache__` are never uploaded. Then:

1. Creates the namespace if it's missing, labeled as made by CanyonOS.
2. The API turns the workflow group's `.env` into a Secret for the Global Controller,
   and each workflow's `.env` into a Secret for that workflow's agents, unless
   `env_secret` names your own.
3. The API asks the operator for a build (a CanyonBuild), with the sha256 of this
   machine's API key in `spec.auth.apiKeyHash` (never the key itself), and uploads the
   workflow group to the build's pod. `.env` and every other `.env*` file never reach it.
4. The build builds each agent's image on the cluster's builder, pushes it by digest,
   and applies the workflow group's objects from its config, its CanyonProject carrying
   that hash in `spec.auth.apiKeyHash`. The operator hands it to the Global Controller
   from the Secret `canyonos-api-key`. A redeploy of unchanged code restarts nothing.
5. The API waits until the operator reports the workflow and every agent ready; the CLI
   then forwards the endpoint to this machine and opens the dashboard.

The first deploy writes a `workflow_group_id` into the record's `workflow_group.yaml`,
and later deploys keep it, so telemetry stays under one workflow across deploys and
targets. A `workflow_group.yaml` with a `workflow_group_id` that a new record starts
from keeps that ID. The workflow's CanyonProject is named after its workflow group, its
folder's name and the start of that ID (`helloworld-4eeed6f3`), so two folders of the
same name never share one in a namespace.

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
- `deploy --api-key` and `--no-api-key` set the endpoint's key only. The cluster
  dashboard keeps its chart's `dashboard.apiKeyHash`.

## Configuration

The block, with its two required settings, is:

```yaml
target: kubernetes
kubernetes:
  namespace: acme # created on deploy if missing and you may create it
  registry: registry.example.com/acme # where images are pushed, and nodes pull from
```

`${VAR}` in the block is filled in from the workflow group's `.env`, which also holds the only
values the build and the Global Controller see. A `${VAR}` in a workflow's config is
filled in from that file too, not from the workflow's own `.env`.

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
An `otel` destination on the local dashboard or on `host.docker.internal` is skipped.
Every other
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
    StateDB: { run_as_user: 70, fs_group: 70, storage: 5Gi } # postgres:16-alpine
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

## The CanyonOS API

Every install has one CanyonOS API, in the `canyonos-dashboard` namespace, and every
`canyonos` command for a workflow on the cluster goes through it, from a port-forward to
`svc/canyonos-dashboard-api`. It is also the [dashboard](#dashboard)'s backend. Its pod,
`canyonos-dashboard-api`, under the `restricted` Pod Security profile, runs:

- `api`, the API itself, from the `canyonos-api` image;
- `core`, from the `canyonos-core` image (`controllerImage`): the `canyonos_core.cli`
  commands the API hands it, such as checking and unpacking an uploaded workflow and
  packing the workflow group for its build. It has no Kubernetes token and no port.

They share the folder `/workspace`, where the uploaded workflow groups are kept while
the pod runs (`dashboard.workspaceSize`, 4Gi). Postgres, on a 1Gi PersistentVolumeClaim,
keeps each workflow group's record. When the pod is replaced, the API finds the
workflows running on the cluster again from their CanyonProjects and keeps them running;
the next `canyonos deploy` of each uploads its files again.

To read its logs:

```bash
kubectl -n canyonos-dashboard logs deploy/canyonos-dashboard-api -c api    # or -c core
```

## Dashboard

One dashboard serves every workflow on the cluster. Its web front end is installed with
the operator unless you pass `--set dashboard.enabled=false`; `canyonos cluster up`
installs it too. It runs in the `canyonos-dashboard` namespace, on the
[CanyonOS API](#the-canyonos-api), under the `restricted` Pod Security profile.

```bash
canyonos serve    # http://127.0.0.1:8081, until canyonos stop
```

- **Opening it:** `canyonos deploy` opens it unless you pass `--serve false`, and says
  so and carries on when the cluster has none; `canyonos serve` opens it on its own. It
  is a port-forward held open in the background, like the endpoint's, on `8081` or the
  next free port; a `dashboard_port` you set is never moved. `canyonos stop` closes it
  with the last workflow forwarded from this machine.
- **Who can open it:** someone allowed to port-forward to `svc/canyonos-dashboard-web`
  in `canyonos-dashboard`, with its API key; nothing is exposed outside the cluster. As
  the local dashboard does, it asks for the key (see
  [API key](AUTHORIZATION.md#send-the-key)).
- **Which key it takes:** the one whose sha256 is the chart's `dashboard.apiKeyHash`,
  kept in the Secret `canyonos-dashboard` as `api-key-hash`. One key covers every
  workflow on the cluster. The chart requires it, since every signed-in user may
  port-forward to the API. Set it at install, from the key you pick:

  ```bash
  helm upgrade --install ... --set dashboard.apiKeyHash="$(printf %s "$KEY" | sha256sum | cut -d' ' -f1)"
  ```

  A new value restarts the API. With `dashboard.existingSecret`, put `api-key-hash` in
  your Secret and restart `canyonos-dashboard-api` after changing it.

- **How it reaches workflows:** the operator lists every workflow whose Redis is ready,
  with how to reach it, in the Secret `canyonos-dashboard-projects`, so the dashboard
  needs no access to any workflow's Secrets. Each workflow's Redis admits the
  dashboard's API pod and nothing else from that namespace, and each Global Controller
  sends its telemetry to the dashboard.

### Dashboard settings

| Setting                                | Default                                          | What it does                                                                                                                                                                                                                                                                               |
| -------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dashboard.apiImage`, `webImage`       | this release's `canyonos-api` and `canyonos-web` | The CanyonOS API's and the web front end's images, for a mirror. The API's `core` container runs `controllerImage`.                                                                                                                                                                        |
| `dashboard.dbImage`                    | `postgres:16-alpine`                             | The database's image.                                                                                                                                                                                                                                                                      |
| `dashboard.storage`                    | `1Gi`                                            | The database's disk, a PersistentVolumeClaim every install makes.                                                                                                                                                                                                                          |
| `dashboard.storageClassName`           | the cluster's default                            | The storage class of that disk.                                                                                                                                                                                                                                                            |
| `dashboard.existingSecret`             | none                                             | Your own Secret with `db-password`, a `redis-password-key` of 32 characters or more, and `api-key-hash`. Without it, the chart makes one on install and keeps it. Set it when the chart is rendered without the cluster (`helm template`, Argo CD), which can't keep a generated password. |
| `dashboard.apiKeyHash`                 | none, required                                   | The sha256 of the dashboard's API key, as 64 lowercase hex characters. The chart refuses to install without it, unless `dashboard.existingSecret` is set.                                                                                                                                  |
| `dashboard.workspaceSize`              | `4Gi`                                            | The CanyonOS API's `/workspace`, which holds every uploaded workflow group while its pod runs.                                                                                                                                                                                             |
| `dashboard.fixedUsers`                 | `true`                                           | Runs the images as their own users. Set it to `false` on OpenShift, which assigns user IDs itself.                                                                                                                                                                                         |
| `dashboard.metricsRawRetentionDays`    | `3`                                              | Days to keep raw five-second metric ticks, which ranges of 30 minutes or less read.                                                                                                                                                                                                        |
| `dashboard.metricsRollupRetentionDays` | `120`                                            | Days to keep five-minute rollups, which longer ranges read.                                                                                                                                                                                                                                |

## Stop and clean up

| Command                 | What it removes                                                                                                                                                                                                       | What stays                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `canyonos stop`         | The workflow's CanyonProject, and with it the endpoint, agents, Global Controller and Redis with its disk. The endpoint's port-forward on this machine, and the dashboard's when no other workflow here is forwarded. | The namespace, the workflow group's ConfigMap, its `.env` Secrets, and each database's disk |
| `canyonos clean`        | What `stop` removes, then the ConfigMap and the `.env` Secrets                                                                                                                                                        | The namespace, each database's disk, and everything on this machine but the port-forwards   |
| `canyonos cluster down` | The local kind cluster, and the port-forwards to it                                                                                                                                                                   | The registry and the images in it, unless you pass `--all`                                  |

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
dashboard's) stays as it was, so pass its new value with `--set`. An install with no
`dashboard.apiKeyHash` or `dashboard.existingSecret` needs one now: pass it with `--set`
too.

`--reuse-values` also keeps the builder and the dashboard's web front end as the install
had them. An install from 0.2.x, where both were off unless set, keeps them off: to turn
them on, add `--set builder.enabled=true --set dashboard.enabled=true`. A `helm upgrade`
without `--reuse-values` takes the new defaults instead, and turns both on, the builder's
privileged `canyonos-build` namespace included.

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
for each failure. [Troubleshooting](TROUBLESHOOTING.md#kubernetes) has more for a local
cluster.

| Problem                                                  | What to do                                                                                                                                                                                                                                    |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "The CanyonOS operator is not installed on this cluster" | [Set up the cluster](#set-up-the-cluster), or point `kubectl` at the right one: `kubectl config use-context <name>`.                                                                                                                          |
| "they must be the same release"                          | [Upgrade the operator](#upgrading-the-operator) to the CLI's release, or deploy with the CLI of the operator's release.                                                                                                                       |
| The namespace "does not exist and could not be created"  | Ask a cluster admin for the namespace, or set one you have as `namespace` in the `kubernetes:` block.                                                                                                                                         |
| "The image build failed"                                 | The error names the build's log: `kubectl -n <namespace> logs job/<build> -c build`. A failed CanyonBuild is kept so you can look at it.                                                                                                      |
| The deploy waits with "no node to run on"                | The message gives the scheduler's reason: too little CPU or memory (see [Configuration](#configuration) for what each pod requests), a taint, or a `node_selector` that no node matches. On a local cluster, give Docker more CPU and memory. |
| An agent fails the deploy at once                        | The operator can never start it as configured. The error gives the operator's reason.                                                                                                                                                         |
| "Not ready after 10 minutes"                             | Look at `kubectl -n <namespace> get pods` and `kubectl -n <namespace> describe canyonagents`.                                                                                                                                                 |
| "The endpoint is not forwarded to this machine"          | The warning gives the reason. Most often the `endpoint.api_port` you set is taken: free it, or remove the setting to take the next free port.                                                                                                 |
| The operator itself misbehaves                           | Read its logs: `kubectl -n canyonos-system logs deploy/canyonos-controller-manager`.                                                                                                                                                          |
| Helm says "dashboard.apiKeyHash is required"             | Set it, as [Set up the cluster](#set-up-the-cluster) shows, or `dashboard.existingSecret`.                                                                                                                                                    |
| `canyonos-dashboard-db-0` stays `Pending`                | Its PersistentVolumeClaim has no StorageClass to bind to: set `dashboard.storageClassName`, or give the cluster a default one.                                                                                                                |
| A deploy fails inside the CanyonOS API                   | Read both of its containers' logs: `kubectl -n canyonos-dashboard logs deploy/canyonos-dashboard-api -c api`, then `-c core`.                                                                                                                 |
