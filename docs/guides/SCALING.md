# Autoscaling

CanyonOS can add and remove replicas of each agent as its load changes, following a
scaling policy you can change while the workflow runs. Without a policy, every agent
runs the `replicas` count set in the workflow config.

**Estimated time:** about 2 minutes. A policy is a five-line file or one API request,
and the Global Controller applies it on its next poll, 5 seconds by default.

## Define the policy in a file

Create `scaling.yaml` in the workflow's `config` folder, or in its copy in the workflow
group's record once the workflow is deployed (see [Configure](CONFIGURE.md)):

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

Each workflow has one policy, and it applies to each of its agents separately: each is
measured on its own load and gains or loses its own replicas. Database entries and the
endpoint's container are never scaled. The policy takes effect on the next
`canyonos sync` (Docker only) or `canyonos deploy`.

A policy that breaks the rules in the table is skipped with a warning in the Global
Controller's log, and none of the workflow's agents is scaled. The
[portfolio example](https://github.com/CanyonCodeCoreAI/canyonos/blob/main/examples/portfolio/portfolio/config/scaling.yaml)
has a full `scaling.yaml`.

### How scaling decides

Each poll (`poll_interval` in `workflow_group.yaml`, 5 seconds by default), the Global
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

Open the workflow group on the [dashboard](DASHBOARD.md) and go to **Scaling**, which has
each workflow's policy. The page works only while the workflow group is running. If a
stored policy is invalid, the page says why.

| Control                       | What it does                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Add policy**                | Creates a policy when there is none                                                                                                          |
| **Edit policy** (pencil icon) | Edits the current policy; **Save policy** applies it on the next poll                                                                        |
| **Delete policy**             | Removes the policy. Its agents then keep their current replica count until the next reload, and the count in the workflow config after that. |
| **Agents now**                | Shows each agent's replicas and its current Throughput and Queue, updated every 5 seconds, so you can watch a change take effect             |

## Change the policy through the API

The dashboard's **Scaling** page uses the dashboard API, and a script can call it too.
On a Docker deploy it listens on port `3000` and takes the [API key](AUTHORIZATION.md).
`<workflow_group_id>` and `<workflow_id>` are in the record's `workflow_group.yaml`.

```bash
curl -X PUT \
  http://127.0.0.1:3000/v1/workflow-groups/<workflow_group_id>/workflows/<workflow_id>/scaling \
  -H "Authorization: Bearer <your api key>" \
  -H "Content-Type: application/json" \
  -d '{"min_replicas": 1, "max_replicas": 6, "metric": "queue_length_total",
       "scale_up_above": 10, "scale_down_below": 1}'
```

It answers with the saved policy, which applies on the next poll. `GET` on the same path
returns the workflow's policy, `DELETE` removes it, and `GET .../scaling/agents` lists
each agent's replicas and load.

## Limits

- Dashboard and API edits are not written back to `scaling.yaml`. On the next reload,
  from `canyonos sync` (Docker only) or a deploy, the Global Controller publishes the file
  again and those edits are lost. Copy any change you want to keep into the record's
  `scaling.yaml`.
- On Docker and EC2, a reload or deploy also sets every agent back to the `replicas`
  count in the workflow config, and scaling starts again from there. On Kubernetes, a
  redeploy keeps each agent's live count; see
  [Kubernetes workflow group](KUBERNETES.md#scaling), which also explains why you should not
  add a HorizontalPodAutoscaler.
- An agent never scales to zero: nothing is measured at zero replicas, so
  `min_replicas` is at least 1.
