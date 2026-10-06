# Autoscaling

CanyonOS can add and remove replicas of each agent based on its load. Without a
scaling policy, every agent runs the replica count set in `global_controller.yaml`.

## Defining the policy

Create a `scaling.yaml` file in the project's config folder. A workflow has one policy,
and it applies to every agent separately: each agent is measured on its own load and
gains or loses its own replicas. The workflow container itself is never scaled.

```yaml
scaling:
  min_replicas: 1
  max_replicas: 6
  metric: requests_per_minute_per_replica
  scale_up_above: 10
  scale_down_below: 1
```

- **min_replicas** and **max_replicas**: the fewest and most replicas each agent can
  run. `min_replicas` can't be more than `max_replicas`.
- **metric**: the load the policy watches. It must be one of these:
  - `requests_per_minute_per_replica`: requests completed per minute, divided by the
    number of running replicas. Shown as **Throughput** on the dashboard.
  - `queue_length_total`: requests waiting across all of the agent's replicas. Shown
    as **Queue length** on the dashboard.
- **scale_up_above**: add a replica when the metric stays above this value.
- **scale_down_below**: remove a replica when the metric stays below this value. It
  must be lower than `scale_up_above`.

`examples/portfolio/config/scaling.yaml` has a full example.

## How scaling decides

The Global Controller measures every agent's load each poll interval (`poll_interval`
in `global_controller.yaml`, 5 seconds by default). It keeps the last 10 measurements
for each agent.

1. If the agent's replica count is outside `min_replicas` and `max_replicas`, it moves
   straight to the nearest limit.
2. Otherwise, it waits until the agent has run at the same replica count for 10
   measurements in a row, with every replica up. That wait also acts as a cooldown
   after each change.
3. It then averages the metric over those 10 measurements. Above `scale_up_above`, it
   adds one replica. Below `scale_down_below`, it removes one. Replicas change one at
   a time.

With the default poll interval, an agent changes by at most one replica about every
50 seconds.

## Editing on the dashboard

Open the project's **Scaling** page. It shows the workflow's policy, and **Add policy**
creates one when there is none. Changes apply on the next poll. The page only
works while the project is running.

## Limits

- Dashboard edits are not written back to `scaling.yaml`. When the Global Controller
  reloads, it publishes the file again and dashboard edits are lost. Copy any change
  you want to keep into `scaling.yaml`.
- On startup and reload, every agent goes back to the replica count in
  `global_controller.yaml`, and scaling starts again from there.
