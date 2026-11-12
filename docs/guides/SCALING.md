# Autoscaling

CanyonOS can add and remove replicas of each agent as its load changes, following a
scaling policy you can change while the workflow runs. Without a policy, every agent
runs the `replicas` count set in the workflow config.

## Define the policy in a file

Create `scaling.yaml` in the workflow's `config` folder:

```yaml
scaling:
  min_replicas: 1
  max_replicas: 6
  metric: requests_per_minute_per_replica
  scale_up_above: 10
  scale_down_below: 1
```

| Setting            | Default  | What it does                                                                                                    |
| ------------------ | -------- | --------------------------------------------------------------------------------------------------------------- |
| `min_replicas`     | required | The fewest replicas each agent runs. A whole number, at least 1                                                 |
| `max_replicas`     | required | The most replicas each agent runs. A whole number, at least `min_replicas`                                      |
| `metric`           | required | The load the policy watches: `requests_per_minute_per_replica` or `queue_length_total`                          |
| `scale_up_above`   | required | Add a replica while the metric stays above this number. A number, 0 or more                                     |
| `scale_down_below` | required | Remove a replica while the metric stays below this number. A number, 0 or more, and lower than `scale_up_above` |

| `metric`                          | Dashboard name | What it measures                                                     |
| --------------------------------- | -------------- | -------------------------------------------------------------------- |
| `requests_per_minute_per_replica` | Throughput     | Requests the agent completed per minute, divided by running replicas |
| `queue_length_total`              | Queue length   | Requests waiting, across all of the agent's replicas                 |

A workflow has one policy, and it applies to every agent separately: each agent is
measured on its own load and gains or loses its own replicas. Database entries and the
endpoint's container are never scaled. The policy takes effect on the next
`canyonos sync` (Docker only) or `canyonos deploy`.

A policy that breaks the rules in the table is skipped with a warning in the Global
Controller's log, and no agent is scaled. The
[portfolio example](https://github.com/CanyonCodeCoreAI/canyonos/blob/main/examples/portfolio/config/scaling.yaml)
has a full `scaling.yaml`.

### How scaling decides

Each poll (`poll_interval` in the workflow config, 5 seconds by default), the Global
Controller measures every agent's load and keeps the last 4 measurements. Then, for each
agent:

1. If its replica count is outside `min_replicas` and `max_replicas`, it moves straight
   to the nearest limit.
2. Otherwise, it waits until all 4 measurements show the same replica count with every
   replica running. That wait is also the cooldown after a change.
3. If the metric is above `scale_up_above` in all 4, it adds one replica. If it is below
   `scale_down_below` in all 4, it removes one, which drains before it stops instead of
   being cut off mid-request.

So an agent changes by at most one replica per 4 polls (20 seconds by default), counted
from when its last change is fully running.

## Change the policy while the workflow runs

Open the workflow on the [dashboard](DASHBOARD.md) and go to **Scaling**. The page works
only while the workflow is running. If the stored policy is invalid, the page says why.

| Control                       | What it does                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Add policy**                | Creates a policy when there is none                                                                                                          |
| **Edit policy** (pencil icon) | Edits the current policy; **Save policy** applies it on the next poll                                                                        |
| **Delete policy**             | Removes the policy. Every agent then keeps its current replica count until the next reload, and the count in the workflow config after that. |
| **Agents now**                | Shows each agent's replicas and its current Throughput and Queue, updated every 5 seconds, so you can watch a change take effect             |

## Limits

- Dashboard edits are not written back to `scaling.yaml`. On the next reload, from
  `canyonos sync` (Docker only) or a deploy, the Global Controller publishes the file again and
  dashboard edits are lost. Copy any change you want to keep into `scaling.yaml`.
- On Docker and EC2, a reload or deploy also sets every agent back to the `replicas`
  count in the workflow config, and scaling starts again from there. On Kubernetes, a
  redeploy keeps each agent's live count; see
  [Kubernetes deployment](KUBERNETES.md#scaling), which also explains why you should not
  add a HorizontalPodAutoscaler.
- An agent never scales to zero: nothing is measured at zero replicas, so
  `min_replicas` is at least 1.
