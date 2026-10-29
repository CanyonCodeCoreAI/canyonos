# Kubernetes deployment

`canyonos deploy --target kubernetes` runs a project on the Kubernetes cluster
`kubectl` points at. The CanyonOS operator, installed once per cluster, runs each
project's Redis, global controller, endpoint and agents in the project's namespace.
The cluster builds the agents' images itself and pushes them to your registry; the
CLI only hands it the project. Nothing else on the cluster changes.

To try it on a laptop, `canyonos cluster up` makes a local cluster with CanyonOS on it;
see [Try it on a laptop](#try-it-on-a-laptop). To develop CanyonOS itself on one, see
[Kubernetes on kind](../contributing/DEVELOPMENT.md#kubernetes-on-kind).

## Install the operator

A cluster admin installs it once, with Helm, from the chart each release publishes
(`<version>` is the CLI's, as `canyonos --version` prints it):

```bash
helm install canyonos oci://ghcr.io/canyoncodecoreai/charts/canyonos-operator \
  --version <version> --namespace canyonos-system --create-namespace \
  --set builder.enabled=true
```

Every CanyonOS image it runs is that release's, from `ghcr.io/canyoncodecoreai`. The CLI
must be the same release, as on Docker, where the CLI runs the images of its own
version: a deploy with another CLI version stops before it uploads anything, and says
whether to upgrade the operator or use the matching CLI.

| Value | Default | What it does |
|---|---|---|
| `imageRegistry` | `ghcr.io/canyoncodecoreai` | Where CanyonOS's own images come from: each one below left empty is `<imageRegistry>/canyonos-<name>:<version>`. Point it at a registry mirror that holds them under the same names. |
| `controllerImage` | this release's `canyonos-core` | The image every project's global controller and endpoint, and the in-cluster build, run. |
| `watchNamespaces` | `[]` | Empty: projects may run in any namespace, with cluster-wide permissions. A list: only those namespaces, with the operator's permissions granted in them alone. |
| `image.repository`, `image.digest` | this release's operator | The operator's own image; prefer a digest. |
| `redisImage` | the operator's default | The image of each project's Redis, for a mirror. |
| `userRoles.enabled` | `true` | Whoever may administer, edit or view a namespace may do the same with its CanyonProjects, CanyonAgents and CanyonBuilds: a namespace's edit role is all `canyonos deploy` needs. |
| `metrics.enabled` | `true` | The operator's Prometheus metrics on :8443 (HTTPS; callers need the `canyonos-metrics-reader` role). |
| `builder.enabled` | `false` | The in-cluster image builder (rootless BuildKit in `canyonos-build`) every deploy builds with. Its namespace is the one Pod Security exception CanyonOS asks for (`privileged`: BuildKit's user namespaces need seccomp and AppArmor unconfined); nothing else runs there, and only build pods may reach it. |
| `builder.registryAliases` | `{}` | A registry the builder reaches by another name than nodes pull it by (kind: `{"localhost:5001": "kind-registry:5000"}`). |
| `builder.insecureRegistries` | `[]` | Registries the builder may push to over plain HTTP (a local kind registry only). |
| `dashboard.enabled` | `false` | One dashboard for every project; see [Dashboard](#dashboard). |

The operator never reads Secrets other than the Redis passwords it needs (by name,
never listed), never changes an object it did not create, and runs every pod under
the restricted Pod Security profile.

## Try it on a laptop

`canyonos cluster up` makes a local Kubernetes cluster to deploy to, with nothing but
the CLI, Docker (4 CPUs and 8 GB or more),
[`kind`](https://kind.sigs.k8s.io/docs/user/quick-start/#installation) and
[`kubectl`](https://kubernetes.io/docs/tasks/tools/) (macOS: `brew install kind kubectl`;
Windows: `winget install Kubernetes.kind Kubernetes.kubectl`):

```bash
canyonos cluster up            # about 10 minutes the first time
```

It starts a registry on `localhost:5001`, makes a kind cluster named `canyonos` (one
control plane and one worker; `--workers 3` for more), with Calico so NetworkPolicy is
enforced, metrics-server and Pod Security `restricted` in every namespace, and installs
CanyonOS of the CLI's own release on it, with the builder and the dashboard. `kubectl`
then points at the cluster. Run it again after upgrading the CLI to bring the cluster
to the same release. Then, in your project's folder, add to
`config/global_controller.yaml`:

```yaml
kubernetes:
  namespace: my-project
  registry: localhost:5001
```

and deploy as in [Deploy and run](#deploy-and-run). `canyonos cluster down` deletes the
cluster (`--all` also the registry and the images in it).

## Configuration

Add a `kubernetes:` block to `global_controller.yaml`:

```yaml
kubernetes:
  namespace: acme                       # required; created when missing and you may create namespaces
  registry: registry.example.com/acme   # required; where images are pushed, and nodes pull from
```

`${VAR}` in the block is filled in from the project's `.env`, the only values the
build in the cluster sees too.

Optional:

| Key | Default | What it does |
|---|---|---|
| `platform` | the nodes' own | `linux/amd64` or `linux/arm64`. Left out, the build targets the architecture of the node it runs on, so an ARM cluster such as Graviton or kind on Apple silicon gets ARM images. On a cluster with both, set it and a `node_selector` for `kubernetes.io/arch`. |
| `image_pull_secret` | none | A `docker-registry` Secret in the namespace for a private registry: the build pushes with it, and every pod pulls with it. |
| `service_account` | the namespace's default | The ServiceAccount agents run as (for IRSA or workload identity). Agents get no Kubernetes API token either way. |
| `env_secret` | made from `.env` | An existing Secret to give every pod as its environment, instead of the one `canyonos deploy` makes from `.env`. |
| `node_selector` | none | Where the project's pods may run. |
| `redis.storage`, `redis.storage_class` | `1Gi`, the cluster's default | The disk of the Redis the operator runs. |
| `redis.host`, `port`, `tls`, `password_secret` | none | Your own Redis (for example ElastiCache) instead; `password_secret` names a Secret with `password` (and optionally `username`). |
| `endpoint.host` | none | Expose the endpoint through an Ingress at this host, of the cluster's ingress class or `endpoint.ingress_class`. On OpenShift the router serves it as a Route. |
| `endpoint.tls_secret` | none | A Secret with the host's certificate: the endpoint is served over https. |
| `endpoint.url` | none | The URL callers use when you expose the endpoint yourself (Gateway API, a service mesh, a Route made by hand). CanyonOS creates nothing for it. |

Without `endpoint.host` or `endpoint.url` the endpoint is reachable inside the
cluster only, at `http://canyonos-endpoint.<namespace>.svc:8080`.

Docker and EC2 settings (`machine_type`, `market_type`, `provider: EC2`, the `ec2:`
block) are ignored, with a warning.

A `type: database` agent runs its stock image as one replica on its own disk at
`volume_path` (required on Kubernetes), which survives a redeploy and the agent's
removal, as a Docker volume does; other agents find it through routing, as on
Docker. Stock images usually expect a user ID, which the restricted profile needs to be
set: give it, and the disk's size, under `kubernetes.databases`:

```yaml
kubernetes:
  databases:
    StateDB: {run_as_user: 70, fs_group: 70, storage: 5Gi}   # postgres:16-alpine
```

## Deploy and run

```bash
canyonos deploy --target kubernetes      # build in the cluster, apply, wait until ready
canyonos status --target kubernetes      # the project and each agent's replicas (--json for scripts)
canyonos logs --target kubernetes        # the global controller's logs (or: HelloAgent, HelloAgent-0)
canyonos stop --target kubernetes        # remove the project; namespace, config and Secret stay
canyonos clean --target kubernetes       # stop, then remove the CLI's ConfigMap and Secret
```

These take the same options as on Docker: `logs [agent or replica] [--tail N|all]
[--no-follow]`, `status [--json]`, and they read the same `global_controller.yaml`.
`stop --all` and `clean --all` (every project on this machine) are Docker's only.

A deploy hands the project to the cluster, as `canyonos deploy` hands it to the global
controller's container on Docker. The CLI turns `.env` into a Secret, asks the operator
for a build (a CanyonBuild) in the project's namespace and uploads the project root
(`.canyon` once the project is converted, as on Docker) to the build's pod through a
port-forward; `.env` and any other `.env*` file, `.git` and local environments are
never uploaded. The build builds each agent's image on the cluster's builder, pushes it by
digest, and applies the project's objects from `global_controller.yaml` itself, so a
redeploy of unchanged code restarts nothing. The CLI needs no Docker for this.

The first deploy writes a `project_id` into `global_controller.yaml`; commit it, so
telemetry stays under one project across deploys and targets. The project is named
after its folder and the start of that id (`helloworld-4eeed6f3`), as on Docker, so two
folders of the same name never share a CanyonProject in a namespace.

The deploy waits until the operator reports the project and every agent ready,
then prints how to call the endpoint. An agent that will never start as configured
(a name that does not fit, an unsupported type) fails the deploy at once with the
operator's reason, and one with no node to run on says so while it waits. A failed
build is kept for a look: the error names its log.

`clean` never deletes the namespace, which may hold more than the project; it says
how when `canyonos deploy` created it. It changes nothing on this machine.

## Upgrading the operator

Helm installs the CRDs once and never upgrades them. Before `helm upgrade` to a release
that changes them, apply the new CRDs yourself, or new fields are dropped
(`--force-conflicts` takes them over from Helm, which installed them):

```bash
helm show crds oci://ghcr.io/canyoncodecoreai/charts/canyonos-operator --version <version> \
  | kubectl apply --server-side --force-conflicts -f -
helm upgrade canyonos oci://ghcr.io/canyoncodecoreai/charts/canyonos-operator \
  --version <version> --namespace canyonos-system --reuse-values
```

`--reuse-values` keeps every value set at install. An image left to the chart follows
the new release by itself; one set by hand (`image.digest`, `controllerImage`, the
dashboard's) stays as it was, so pass its new value with `--set`, or the operator
upgrades while the images it runs do not.

Never delete a CRD: deleting it deletes every project of its kind in the cluster.

## Dashboard

One dashboard serves every project on the cluster. Install it with the operator, by
adding `--set dashboard.enabled=true`.

It runs in `canyonos-dashboard`: the API, the web front end and Postgres on a 1Gi
disk, all under the restricted Pod Security profile. Open it with:

```bash
canyonos serve --target kubernetes     # http://127.0.0.1:8081 until Ctrl+C
```

It is a port-forward: only someone allowed to port-forward into `canyonos-dashboard`
can open it, and nothing is exposed outside the cluster. It always asks to sign in
(`AUTH_MODE=password`), unlike the local dashboard: every project's global controller
may reach its API. The first account made is its only one; registration closes after it.

The operator lists every project whose Redis is ready, with how to reach it, in one
Secret there (`canyonos-dashboard-projects`); the dashboard reads that file and needs
no access to any project's Secrets. Each project's Redis admits the dashboard's API
pod and nothing else from that namespace, and each project's global controller sends
its telemetry to the dashboard.

| Value | Default |
|---|---|
| `dashboard.apiImage`, `webImage` | this release's `canyonos-api` and `canyonos-web` |
| `dashboard.dbImage` | `postgres:16-alpine` |
| `dashboard.storage`, `storageClassName` | `1Gi`, the cluster's default |
| `dashboard.existingSecret` | none: the chart makes the database password and JWT secret on install and keeps them. Give your own Secret (`db-password`, `jwt-secret` of 32 characters or more) when the chart is rendered without the cluster (`helm template`, Argo CD), which cannot keep a generated password. |
| `dashboard.fixedUsers` | `true`; set `false` on OpenShift, which assigns user IDs itself |

## Scaling

The global controller scales each agent through its CanyonAgent's `/scale`, the
same way an HPA would, within the bounds of `scaling.yaml`. Do not add a
HorizontalPodAutoscaler (or KEDA ScaledObject) for a CanyonAgent: two scalers undo
each other's counts. The operator reports one as the agent's `ScalingConflict`
condition, and `canyonos status` shows it; it never changes your HPA.

A redeploy keeps the live count of autoscaled agents, so it does not undo the
global controller's scaling.

Starting points for alerts: an agent's CPU above 70 % of its limit for five minutes,
the endpoint (always one replica) above one core, p95 time to a result above 2 s, and
a CanyonAgent `Ready=False` with reason `Unschedulable`.

## Rotating the Redis password

The operator makes each project's Redis password once, in the Secret `canyonos-redis`.
Deleting it rotates the password: the operator makes a new one, restarts Redis with
it, then restarts the global controller, the endpoint and the agents (one pod at a
time) so they sign in with it. Until a pod is restarted it cannot reach Redis, so
requests fail for the minute or two the restart takes.

```bash
kubectl -n <namespace> delete secret canyonos-redis
```

## Stopping and deleting

Deleting a CanyonProject (what `canyonos stop` does) takes it down in order: the
endpoint first, so no new request arrives; then each agent, taken out of routing
before its pods are stopped; Redis and the global controller last. Redis's disk goes
with it. An external Redis is left clean of CanyonOS's routing keys.

## Known limits

- A pod stopped by a scale-down, an update or `canyonos stop` does not yet finish the
  calls it holds; those requests fail. Draining on shutdown comes with the core's
  drain support.
- The dashboard's namespace holds every project's Redis password, in
  `canyonos-dashboard-projects`. Let only cluster admins read Secrets there.
- The builder admits any pod labelled as a CanyonOS build, and the dashboard's API
  takes telemetry from any pod labelled as a project's global controller; labels are
  not proof of identity. Mutual TLS between them is planned.
- Rotating the Redis password interrupts requests while the project's pods restart.
- `canyonos export` (the project's objects as a file, for GitOps) is not there yet.
