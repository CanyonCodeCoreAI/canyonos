# Operator

The operator runs CanyonOS workflow groups on Kubernetes. It is a Go controller manager
(kubebuilder, controller-runtime) that does there what the [Reconciler](RECONCILER.md)
does on Docker and EC2.

A deploy renders a CanyonProject and one CanyonAgent per agent. The operator turns them
into the workflow group's Redis, Global Controller and endpoint, and each agent's pods, and keeps
every agent at its replica count with rolling updates and an ordered teardown. It also
writes the replica records and the routing table to the workflow group's Redis, so the
controllers read the same keys they read on Docker.

The Global Controller still decides how many replicas run. It patches each CanyonAgent's
`/scale` subresource.

## How it fits

```mermaid
flowchart TB
    CLI["canyonos deploy"] -->|"creates, uploads"| B["CanyonBuild"]
    B -->|"build Job: apply-project"| P["CanyonProject"]
    B -->|"build Job: apply-project"| A["CanyonAgent"]
    P --> O["Operator"]
    A --> O
    O --> W["Redis, Global Controller,<br/>endpoint, agent StatefulSets"]
    O -->|"replica records, routing"| R["Workflow group Redis"]
    G["Global Controller"] -->|"patches /scale"| A
```

## Resources

All three are in `canyonos.canyoncode.ai/v1alpha1`.

| Resource      | Short name | One per                              | Becomes                                                                   |
| ------------- | ---------- | ------------------------------------ | ------------------------------------------------------------------------- |
| CanyonProject | `cproj`    | workflow group, in its namespace     | Redis, Global Controller, endpoint, and a Service for callers             |
| CanyonAgent   | `cagent`   | agent of a workflow group            | a StatefulSet and headless Service (a database agent keeps one disk)      |
| CanyonBuild   | `cbuild`   | in-cluster build of a workflow group | a Job that receives the upload, builds images, applies the workflow group |

A CanyonAgent's `metadata.name` must be the agent's name lowercased, with anything but
letters, digits and hyphens turned into hyphens (`HelloAgent` becomes `helloagent`). The
CLI and the Global Controller use the same rule. Any other name is not run and reports
`NameMismatch`.

## How it works

1. A CanyonProject creates Redis first. The Global Controller and the endpoint start
   once Redis is ready.
2. A CanyonAgent starts once the CanyonProject's `RedisReady` condition is true.
3. Each pod's readiness probe is the Local Controller's `/readyz`. Pod changes requeue
   the agent, and the operator writes what is ready to Redis.
4. A pod that is deleted leaves routing at once. A `preStop` pause keeps it taking calls
   while routing reloads, then the Local Controller drains on SIGTERM (see
   [Teardown](RECONCILER.md#teardown)).
5. Updates are a surge update the operator runs itself: one extra replica from the new
   revision, then old pods replaced one at a time once the new ones are ready.
6. A pod still stopping a minute after its grace period ends counts as lost and is
   force-deleted so the StatefulSet can replace it. A database pod never is, since the
   node may still be writing its disk.

`spec.auth.apiKeyHash` says who may call the endpoint: the sha256 of the deploying
machine's API key, as 64 lowercase hex characters (see [Endpoint](ENDPOINT.md#api-key)).
The flow:

1. The CLI sends the API key's hash to the CanyonOS API, which writes
   `{"apiKeyHash": "<hash>"}` into the CanyonBuild's `spec.auth`, or leaves `spec.auth`
   out when the machine has no key.
2. The build pod gets it as `CANYONOS_API_KEY_HASH`, and its `apply-project` writes it into
   the CanyonProject's `spec.auth.apiKeyHash`.
3. The operator keeps it in the project's Secret `canyonos-api-key` (key `hash`, empty
   for none), and the Global Controller reads `CANYONOS_API_KEY_HASH` from that Secret,
   never from its pod spec. The Secret's version on the pod template
   (`canyonos.canyoncode.ai/api-key`) restarts the Global Controller on a new key.

The key itself never reaches the cluster. A CanyonProject without `spec.auth` gets an
empty hash, so its endpoint answers anyone who reaches it.

The operator never adopts an object it did not create. Pods that sign in to Redis carry
the login Secret's version, so a rotated password restarts them.

## The Redis contract

On Kubernetes there is no Reconciler, so the operator writes the keys the Reconciler
writes on Docker, from what Kubernetes reports. The operator and the Reconciler must
write the same formats, since the Global Controller and the endpoint read them without
knowing which one wrote them.

| Key                              | Holds                                                             |
| -------------------------------- | ----------------------------------------------------------------- |
| `agent_instance:<replica_id>`    | One record per pod that is ready and not terminating              |
| `agent:<Agent>:instances`        | The agent's replica IDs                                           |
| `agent:<Agent>:desired_replicas` | Mirrored from the CanyonAgent's `spec.replicas`                   |
| `routing_table:*`                | `agents`, `addresses`, `stateful`, `up`, `replicas`               |
| `operator:<Agent>:addresses`     | The operator's own list of addresses whose status keys may remain |

The replica ID is `<Agent>-<pod ordinal>` (`HelloAgent-0`). The record formats are
those core writes. `internal/redisstate/testdata/contract.json` records them for
reference, and no test reads it. Both reconcilers write through
one function, so neither drops the other's agents, and the operator rewrites everything
at least once a minute in case Redis lost it. For the full schema, see
[Redis schema](RECONCILER.md#redis-schema).

## Dashboard, deletion and install

- **Dashboard:** with `--dashboard-namespace`, the operator keeps one Secret there,
  `canyonos-dashboard-projects`, listing each workflow whose Redis is ready and how to
  sign in to it.
- **Dashboard key:** the chart, not the operator, sets the dashboard's key. The chart's
  `dashboard.apiKeyHash` goes into its Secret `canyonos-dashboard` as `api-key-hash`
  (or `dashboard.existingSecret` carries it), and the API reads it as
  `CANYONOS_API_KEY_HASH`. Empty, the API answers anyone who reaches it.
- **Deletion:** the finalizer `canyonos.canyoncode.ai/teardown` holds a CanyonAgent or
  CanyonProject until it is taken down in order. An agent is unrouted, then its
  StatefulSet is deleted and its pods drain. A CanyonProject deletes its endpoint and agents,
  waits for their pods, then cleans its keys from Redis. An unreachable Redis is
  skipped after five minutes.
- **Install:** the Helm chart installs the operator as a Deployment, with leader
  election. Its flags and options are in `charts/canyonos-operator/values.yaml`.
- **Generated files:** `make manifests` generates the CRDs and the manager's RBAC into
  the chart from the Go types and `+kubebuilder:rbac` markers. CI fails if they are not
  committed.

## Code

Paths are relative to `packages/operator`.

| Path                        | What it holds                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `api/v1alpha1/`             | The CRD types                                                                                |
| `cmd/main.go`               | The manager, its flags and caches                                                            |
| `internal/controller/`      | The reconcilers, rollout, teardown and the dashboard's workflow list                         |
| `internal/builders/`        | The Kubernetes objects each resource becomes, including the agent's environment (`agent.go`) |
| `internal/redisstate/`      | The replica records and routing table written to Redis                                       |
| `charts/canyonos-operator/` | The Helm chart; `crds/` and `files/role.yaml` are generated                                  |

## Changing it

From `packages/operator`, `make manifests generate fmt vet test lint` runs everything
CI runs: envtest for the controllers in `internal/controller/`. For the whole path on a
real cluster, see [Kubernetes on kind](../contributing/DEVELOPMENT.md#kubernetes-on-kind).

- A CRD type change: run `make generate manifests`, and update the Python renderer in
  core with it.
- A Redis key change: change core's side first, then the operator's writer
  (`internal/redisstate/writer.go`).

The user guide is [Kubernetes workflow group](../guides/KUBERNETES.md).
