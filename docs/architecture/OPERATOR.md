# Operator

`packages/operator` is the Go operator (kubebuilder, controller-runtime) that runs
CanyonOS projects on Kubernetes. It owns three custom resources in
`canyonos.canyoncode.ai/v1alpha1`:

- **CanyonProject**: one project. The operator runs its Redis (or uses an external
  one), its global controller and its endpoint, in the project's namespace.
- **CanyonAgent**: one agent of a project, run as a StatefulSet behind a headless
  Service. Its `/scale` subresource is how the global controller changes its count.
- **CanyonBuild**: one in-cluster build of a project's images, which then applies the
  project. `canyonos deploy --target kubernetes` creates it and uploads the project to
  its pod.

## What a CanyonProject becomes

| Object | Purpose |
|---|---|
| Secret `canyonos-redis` | Redis's generated password and config; created once, deleting it rotates the password. |
| StatefulSet, Service, NetworkPolicy `canyonos-redis` | Redis, reachable only from the project's pods, the operator and the cluster dashboard's API. |
| ServiceAccount, Role, RoleBinding `canyonos-gc` | The global controller's identity: patch `canyonagents/scale`, read pods and pod metrics, in its namespace only. |
| Deployment `canyonos-gc` | `canyonos_core.cli run-gc` with `CANYONOS_TARGET=kubernetes`; started once Redis is ready. |
| StatefulSet and headless Service `endpoint` | The endpoint (gunicorn plus a routing-only LocalController); its pod keeps the name `endpoint-0`, where replicas send results. |
| Service `canyonos-endpoint`, optional Ingress | Where callers reach the endpoint. |

Every object is labelled, owned by its CanyonProject or CanyonAgent, and created only
when nothing of that name exists: an object CanyonOS did not create is never adopted.

The pod template of every pod that signs in to Redis (the global controller, the
endpoint, the agents) carries the version of the Secret with the Redis password (its
UID and resourceVersion, never anything of its contents). A rotated password changes
it, so those pods restart with the new one, agents and the endpoint one pod at a time.

## What a CanyonBuild becomes

A Job with two containers, a ServiceAccount and a Role allowing only what applying the
project needs, all owned by the build. The `receive` container takes the project's
upload; the `build` container builds the images on the cluster's BuildKit, pushes them
by digest and runs `apply-project`. The build reads only its own Job's pod, and gives
up with the receiver when no upload arrives. Its status says how far it got:
Pending, Receiving (with the pod to upload to), Building, then Succeeded with the
images or Failed with the build's own error.

## The Redis contract

On Docker the reconciler writes each replica's record and the routing table. On
Kubernetes there is no reconciler; the operator writes the same keys from what
Kubernetes reports:

- a record `agent_instance:<replica_id>` (`agent_instance:HelloAgent-0`) and the
  replica set `agent:<Agent>:instances` for each pod that is ready and not
  terminating;
- `routing_table:agents`, `routing_table:addresses` and `routing_table:stateful`
  for every agent and the endpoint;
- `agent:<Agent>:desired_replicas`, mirrored from the CanyonAgent.

A replica's address is its pod's DNS name (`helloagent-0.helloagent.<ns>.svc:50051`),
and its ID `<Agent>-<pod ordinal>` (`HelloAgent-0`), in the place of the random ID
Docker and EC2 give a replica: a StatefulSet pod keeps its ordinal, so the ID is stable
as long as the pod is. The pod learns it only from `CANYONOS_REPLICA_ID`, set in its
spec, as Docker and EC2 pass theirs at `docker run`. Routing lists an agent's
replicas oldest first, as core does.
A pod leaves routing the moment it starts terminating. The key formats are generated
from core's Python (`packages/core/tests/kubernetes_contract.py` writes
`internal/redisstate/testdata/contract.json`) and tested on both sides.

## The dashboard's list of projects

With `--dashboard-namespace` (the chart sets it with `dashboard.enabled`), the operator
keeps one Secret there, `canyonos-dashboard-projects`, naming every project whose
Redis is ready and how to reach and sign in to it. It is rewritten when a project is
added, removed or renamed, turns ready, or its Redis password rotates. The dashboard
mounts it as a file and needs no permission on any project's Secrets.

## Deletion

A finalizer holds each CanyonAgent and CanyonProject until it is taken down in order.
An agent is unrouted and its records removed, then its StatefulSet is deleted and its
pods stop; once they are gone their status keys go and the agent is released. A
project stops its endpoint, deletes its agents and waits for their pods before its
Redis and global controller go. A deletion never waits forever: an unreachable Redis
is skipped after five minutes, and a pod past its grace period on a lost node counts
as gone (never a database's: its disk may still be written to).

## Install and permissions

The Helm chart in `packages/operator/charts/canyonos-operator` installs the operator
cluster-wide or, with `watchNamespaces`, with its permissions granted in those
namespaces only. `make manifests` generates the CRDs and the operator's rules from the
Go types and `+kubebuilder:rbac` markers straight into the chart, and CI fails when a
change forgot to commit them. Secrets are read by name through the API server and
never cached, so the operator holds no list or watch on them.

## Developing

Everything runs in the `golang:1.27.0` container:
`make manifests generate fmt vet test lint` (envtest for the controllers, miniredis
for the Redis writer). For the whole path on a real cluster, see
[Kubernetes on kind](../contributing/DEVELOPMENT.md#kubernetes-on-kind); the user guide
is [Kubernetes deployment](../guides/KUBERNETES.md).
